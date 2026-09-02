import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryMaster } from "./schema.js";

export class ConcurrentInventoryUpdateError extends Error {
  constructor(productId: string) {
    super(`Exceeded retries updating inventory for product ${productId} (concurrent writers)`);
    this.name = "ConcurrentInventoryUpdateError";
  }
}

export interface ApplySaleResult {
  quantity: number;
  soldOut: boolean;
  /** True if the product was already sold out before this call — the other channel's
   *  "sold" event arrived second and this call is a no-op (this IS the double-sell guard). */
  alreadyZero: boolean;
}

/**
 * Applies a sale to the central inventory using optimistic concurrency control
 * (compare-and-swap on `version`). This is the mechanism that prevents double-selling:
 * whichever channel's "sold" event is processed first wins the race and drives quantity
 * to 0 / soldOut; the second arrival (from the other channel, or a duplicate delivery of
 * the same event) sees soldOut already true and returns alreadyZero without going
 * negative. Callers MUST also wrap this in packages/core's withIdempotency() keyed on
 * the channel's order id, since CAS alone doesn't dedupe the *same* sale processed twice.
 */
export async function applySale(
  db: Database,
  productId: string,
  quantitySold: number,
  maxRetries = 5,
): Promise<ApplySaleResult> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const [current] = await db
      .select()
      .from(inventoryMaster)
      .where(eq(inventoryMaster.productId, productId))
      .limit(1);

    if (!current) {
      throw new Error(`inventory_master row missing for product ${productId}`);
    }

    if (current.soldOut || current.quantity <= 0) {
      return { quantity: 0, soldOut: true, alreadyZero: true };
    }

    const newQuantity = Math.max(0, current.quantity - quantitySold);
    const updated = await db
      .update(inventoryMaster)
      .set({
        quantity: newQuantity,
        soldOut: newQuantity === 0,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryMaster.productId, productId), eq(inventoryMaster.version, current.version)))
      .returning();

    if (updated.length > 0) {
      return { quantity: newQuantity, soldOut: newQuantity === 0, alreadyZero: false };
    }
    // version mismatch — another worker updated concurrently; loop and retry the CAS.
  }

  throw new ConcurrentInventoryUpdateError(productId);
}

/**
 * Availability advertised to a channel, after safety-stock withholding. Reduces — never
 * eliminates — the window where the same physical last unit could be sold on two channels
 * at once during sync lag: with `trueQuantity=3, safetyStockBuffer=1`, a secondary channel
 * only ever shows 2 as available, so it takes 3 near-simultaneous sales (2 there, 1 on the
 * source channel) to actually run out, not 2. It cannot help once trueQuantity is already
 * at or below the buffer (most visibly at trueQuantity=1) — that residual risk is what the
 * faster polling / webhook work (item #1) addresses instead.
 *
 * Only ever applied to a *secondary* channel; the source channel (BASE, where sourceChannel
 * originates) always sees true stock, since BASE itself is never told to withhold anything.
 */
export function calculateChannelAvailableQuantity(
  trueQuantity: number,
  safetyStockBuffer: number,
  channel: string,
  sourceChannel: string,
): number {
  if (channel === sourceChannel) return trueQuantity;
  return Math.max(0, trueQuantity - safetyStockBuffer);
}
