import type { ChannelType } from "@ai-ec/core";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryEvents, inventoryMaster } from "./schema.js";

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
 * negative. Callers MUST also wrap this in packages/core's withIdempotency() guard keyed
 * on the channel's order id, since CAS alone doesn't dedupe the *same* sale processed twice.
 *
 * Every sale is also appended to inventory_events (for reconstructInventory()), and an
 * eBay sale bumps ebaySoldSinceBaseSync so a later BASE stock report can reconcile without
 * clobbering it — see applyBaseStockReport.
 */
export interface ApplySaleOptions {
  channel: ChannelType;
  sequenceAt?: Date;
  externalEventId?: string;
  maxRetries?: number;
}

export async function applySale(
  db: Database,
  productId: string,
  quantitySold: number,
  options: ApplySaleOptions,
): Promise<ApplySaleResult> {
  const { channel, sequenceAt = new Date(), externalEventId, maxRetries = 5 } = options;
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
        ebaySoldSinceBaseSync: channel === "ebay" ? current.ebaySoldSinceBaseSync + quantitySold : current.ebaySoldSinceBaseSync,
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryMaster.productId, productId), eq(inventoryMaster.version, current.version)))
      .returning();

    if (updated.length > 0) {
      await db.insert(inventoryEvents).values({
        productId,
        channel,
        eventType: "sale",
        sequenceAt,
        quantityDelta: quantitySold,
        externalEventId: externalEventId ?? null,
        applied: true,
      });
      return { quantity: newQuantity, soldOut: newQuantity === 0, alreadyZero: false };
    }
    // version mismatch — another worker updated concurrently; loop and retry the CAS.
  }

  throw new ConcurrentInventoryUpdateError(productId);
}

export interface ApplyBaseStockReportResult {
  applied: boolean;
  quantity: number;
  /** Set when applied=false, e.g. "out_of_order" — a report whose sequenceAt isn't newer
   *  than the last one actually applied for this product. */
  reason?: string;
}

/**
 * Reconciles BASE's own reported absolute stock number into inventory_master. BASE is the
 * source of truth for its own stock, but naively overwriting `quantity` with it would erase
 * any eBay sale BASE doesn't know about (BASE and eBay never sync directly, and this
 * platform only ever calls the *other* channel's setInventory() at total sellout, not on
 * every partial decrement) — so the true value is computed as
 * `reported - ebaySoldSinceBaseSync`, and that accumulator is reset once applied.
 *
 * `sequenceAt` (BASE's own `modified` timestamp) is this channel's logical clock: a report
 * whose sequenceAt is not strictly newer than inventory_master.lastBaseSeq is a stale or
 * out-of-order delivery (e.g. a retried/delayed poll) and is recorded but not applied,
 * rather than silently trusted — this is the reversal-detection product-fetch relies on.
 */
export async function applyBaseStockReport(
  db: Database,
  productId: string,
  reportedQuantity: number,
  sequenceAt: Date,
  maxRetries = 5,
): Promise<ApplyBaseStockReportResult> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const [current] = await db
      .select()
      .from(inventoryMaster)
      .where(eq(inventoryMaster.productId, productId))
      .limit(1);

    if (!current) {
      throw new Error(`inventory_master row missing for product ${productId}`);
    }

    if (current.lastBaseSeq && sequenceAt.getTime() <= current.lastBaseSeq.getTime()) {
      // Equal timestamp just means "BASE hasn't changed since we last synced" -- a normal,
      // frequent outcome of polling, not a problem. Only a strictly older sequence is an
      // actual reversal (a delayed/retried delivery arriving after a newer one already
      // applied). Distinguishing the two matters for computeSyncConfidence, which must not
      // let ordinary no-op polls masquerade as sync-quality problems.
      const isGenuineReversal = sequenceAt.getTime() < current.lastBaseSeq.getTime();
      const reason = isGenuineReversal ? "out_of_order" : "unchanged";
      await db.insert(inventoryEvents).values({
        productId,
        channel: "base",
        eventType: "base_stock_report",
        sequenceAt,
        absoluteQuantity: reportedQuantity,
        applied: false,
        skippedReason: reason,
      });
      return { applied: false, quantity: current.quantity, reason };
    }

    const reconciledQuantity = Math.max(0, reportedQuantity - current.ebaySoldSinceBaseSync);
    const updated = await db
      .update(inventoryMaster)
      .set({
        quantity: reconciledQuantity,
        soldOut: reconciledQuantity === 0,
        version: current.version + 1,
        lastBaseSeq: sequenceAt,
        ebaySoldSinceBaseSync: 0,
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryMaster.productId, productId), eq(inventoryMaster.version, current.version)))
      .returning();

    if (updated.length > 0) {
      await db.insert(inventoryEvents).values({
        productId,
        channel: "base",
        eventType: "base_stock_report",
        sequenceAt,
        absoluteQuantity: reportedQuantity,
        applied: true,
      });
      return { applied: true, quantity: reconciledQuantity };
    }
    // version mismatch — another worker updated concurrently; loop and retry the CAS.
  }

  throw new ConcurrentInventoryUpdateError(productId);
}

/**
 * Recomputes what inventory_master.quantity *should* be by replaying every applied
 * inventory_events row in sequence order, starting from the most recent base_stock_report
 * (or 0 if none exists) and applying every sale after it. This is the recovery path for
 * item #3 ("状態再構築"): if the mutable counter is ever suspected of having drifted from
 * reality (a bug, a manual DB edit, a botched migration), this recomputes the correct value
 * from the durable event history instead of trusting the counter itself. It does not write
 * anything — callers decide whether/how to reconcile the discrepancy it reports.
 */
export interface ReconstructInventoryResult {
  reconstructedQuantity: number;
  currentQuantity: number;
  drifted: boolean;
  eventsReplayed: number;
}

export async function reconstructInventory(db: Database, productId: string): Promise<ReconstructInventoryResult> {
  const [current] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  if (!current) {
    throw new Error(`inventory_master row missing for product ${productId}`);
  }

  const events = await db
    .select()
    .from(inventoryEvents)
    .where(and(eq(inventoryEvents.productId, productId), eq(inventoryEvents.applied, true)));

  const sorted = [...events].sort((a, b) => a.sequenceAt.getTime() - b.sequenceAt.getTime());

  const lastBaseReportIndex = (() => {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i]!.eventType === "base_stock_report") return i;
    }
    return -1;
  })();

  let quantity = lastBaseReportIndex >= 0 ? (sorted[lastBaseReportIndex]!.absoluteQuantity ?? 0) : 0;
  const replayFrom = lastBaseReportIndex >= 0 ? lastBaseReportIndex + 1 : 0;
  let eventsReplayed = lastBaseReportIndex >= 0 ? 1 : 0;

  for (let i = replayFrom; i < sorted.length; i += 1) {
    const event = sorted[i]!;
    if (event.eventType === "sale") {
      quantity = Math.max(0, quantity - (event.quantityDelta ?? 0));
      eventsReplayed += 1;
    }
  }

  return {
    reconstructedQuantity: quantity,
    currentQuantity: current.quantity,
    drifted: quantity !== current.quantity,
    eventsReplayed,
  };
}

export interface ApplyReconstructedInventoryResult extends ReconstructInventoryResult {
  applied: boolean;
}

/**
 * The recovery half of item #3 ("状態再構築"): calls reconstructInventory() and, only if it
 * found real drift, writes the recomputed quantity back via the same CAS pattern as
 * applySale/applyBaseStockReport (so it can't clobber a sale that lands mid-repair). This
 * is always human-triggered (an admin action), never automatic — matching this platform's
 * existing "never silently auto-correct inventory drift" stance (see inventory-diff-check),
 * since drift can also mean an undiscovered bug, not just an expected delay.
 */
export async function applyReconstructedInventory(
  db: Database,
  productId: string,
  maxRetries = 5,
): Promise<ApplyReconstructedInventoryResult> {
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const result = await reconstructInventory(db, productId);
    if (!result.drifted) {
      return { ...result, applied: false };
    }

    const [current] = await db
      .select()
      .from(inventoryMaster)
      .where(eq(inventoryMaster.productId, productId))
      .limit(1);
    if (!current) throw new Error(`inventory_master row missing for product ${productId}`);

    const updated = await db
      .update(inventoryMaster)
      .set({
        quantity: result.reconstructedQuantity,
        soldOut: result.reconstructedQuantity === 0,
        version: current.version + 1,
        updatedAt: new Date(),
      })
      .where(and(eq(inventoryMaster.productId, productId), eq(inventoryMaster.version, current.version)))
      .returning();

    if (updated.length > 0) {
      return { ...result, applied: true };
    }
    // version mismatch — a sale (or another repair) landed between our read and our write;
    // loop and recompute from scratch rather than blindly retrying the stale write.
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
