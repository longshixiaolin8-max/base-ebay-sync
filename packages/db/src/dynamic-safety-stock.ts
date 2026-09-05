import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryEvents } from "./schema.js";
import { computeSyncConfidence } from "./sync-confidence.js";

export interface DynamicSafetyStockResult {
  productId: string;
  channel: string;
  /** Recommended value for inventory_master.safety_stock_buffer. */
  recommendedBuffer: number;
  salesPerDay: number;
  windowDays: number;
  pollIntervalMinutes: number;
  confidenceScore: number;
  riskMultiplier: number;
}

/**
 * Item #2 of the hardening list ("動的安全在庫 -- API遅延・エラー率・販売速度から
 * 販売可能数を自動調整"). The static safetyStockBuffer (item #6 of the earlier round)
 * shrinks the double-sell window for a fixed number of units, chosen by hand; this
 * computes what that number *should* be from two real, already-recorded signals:
 *
 *  - sales velocity: units sold on any channel in the trailing window (inventory_events,
 *    item #1's ledger) -> expected sales during one sync cycle (pollIntervalMinutes).
 *  - sync reliability: the channel's computeSyncConfidence() score -> when a channel's own
 *    sync has recently been unreliable (errors, reversals), a sync cycle's *effective*
 *    length is unpredictable, so the buffer is widened as insurance.
 *
 * There is no real per-call API-latency metric recorded anywhere in this platform, so this
 * deliberately does not invent one -- confidence score is the real, already-measured proxy
 * for "this channel's sync has been taking longer / failing more than usual" instead.
 */
export async function computeDynamicSafetyStock(
  db: Database,
  productId: string,
  channel: string,
  options: { windowDays?: number; pollIntervalMinutes?: number } = {},
): Promise<DynamicSafetyStockResult> {
  const windowDays = options.windowDays ?? 7;
  const pollIntervalMinutes = options.pollIntervalMinutes ?? 1;
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const sales = await db
    .select()
    .from(inventoryEvents)
    .where(
      and(
        eq(inventoryEvents.productId, productId),
        eq(inventoryEvents.eventType, "sale"),
        eq(inventoryEvents.applied, true),
        gte(inventoryEvents.createdAt, since),
      ),
    );
  const totalSold = sales.reduce((sum, s) => sum + (s.quantityDelta ?? 0), 0);
  const salesPerDay = totalSold / windowDays;

  const confidence = await computeSyncConfidence(db, channel);
  // Sync has recently looked unreliable -> a cycle's real-world length is less predictable,
  // so widen the buffer as insurance against a slower-than-usual sync catching a sale late.
  const riskMultiplier = confidence.score >= 80 ? 1 : confidence.score >= 50 ? 1.5 : 2;

  const expectedSalesPerCycle = salesPerDay * (pollIntervalMinutes / (24 * 60));
  const recommendedBuffer = Math.max(0, Math.ceil(expectedSalesPerCycle * riskMultiplier));

  return {
    productId,
    channel,
    recommendedBuffer,
    salesPerDay,
    windowDays,
    pollIntervalMinutes,
    confidenceScore: confidence.score,
    riskMultiplier,
  };
}
