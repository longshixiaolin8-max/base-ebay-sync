import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { API_ERROR_STATUS_PATTERN } from "./rate-control.js";
import { channelListings, inventoryEvents, syncErrors } from "./schema.js";

export interface SyncConfidence {
  channel: string;
  /** 0-100. 100 when there's no recent activity to judge either way (never starts a
   *  brand-new channel out at 0 for lack of evidence). */
  score: number;
  windowHours: number;
  successCount: number;
  failureCount: number;
  outOfOrderEventCount: number;
  totalEventCount: number;
}

/**
 * Scores how trustworthy a channel's recent sync activity has been, from two real signals
 * already recorded elsewhere in this platform — never a guessed/invented metric:
 *
 *  - error rate: sync_errors rows for this channel vs. channel_listings rows that synced
 *    successfully, both in the trailing window.
 *  - reversal rate: the fraction of this channel's inventory_events (see applyBaseStockReport
 *    / applySale) that were rejected as out-of-order rather than applied.
 *
 * The two are averaged into one 0-100 score. Used to gate new eBay publishes when eBay's
 * own sync pipeline currently looks unreliable — see ebay-sync-worker's publish() preflight.
 */
export async function computeSyncConfidence(
  db: Database,
  tenantId: string,
  channel: string,
  windowHours = 24,
): Promise<SyncConfidence> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const recentSyncErrors = await db
    .select()
    .from(syncErrors)
    .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.channel, channel), gte(syncErrors.createdAt, since)));
  // Confirmed live (Sept 2026): ai-generate-worker tags Bedrock/OpenAI quota errors with
  // channel:"ebay" too (since they block that channel's own listing), and an unfiltered count
  // let a same-day AI-provider outage alone crash this score to 0 and pause every new eBay
  // publish -- for a reason that says nothing about eBay's own API actually being unreliable.
  // rate-control.ts's shouldThrottleChannel already had this exact fix; this was the one other
  // sync_errors consumer still missing it. Only rows shaped like the adapters' own
  // "<Channel> API error <status>:" format are genuine evidence of that channel's API health.
  const failures = recentSyncErrors.filter((e) => API_ERROR_STATUS_PATTERN.test(e.errorMessage));
  // Confirmed live (Oct 2026): a single SKU stuck on one persistent, externally-caused error
  // (e.g. eBay requiring additional seller registration) gets retried -- by SQS's own
  // redelivery-on-failure, DLQ redrive, or an admin's manual retry -- producing many
  // sync_errors rows for that one product within the window. Counting raw rows let that one
  // stuck listing alone crash the score to 0 and block every *other* product's publish too,
  // even though it says nothing about eBay's API being broken for anything else. Counting
  // distinct failing products instead means the gate only trips when several different
  // listings are genuinely failing -- the actual signal this score exists to capture.
  const successes = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.channel, channel), gte(channelListings.lastSyncedAt, since)));

  const rawEvents = await db
    .select()
    .from(inventoryEvents)
    .where(and(eq(inventoryEvents.tenantId, tenantId), eq(inventoryEvents.channel, channel), gte(inventoryEvents.createdAt, since)));
  // A report equal to the current watermark just means "nothing changed since last poll" --
  // an ordinary, frequent outcome, not evidence of a sync problem. Only a genuine reversal
  // (skippedReason "out_of_order", strictly older than the watermark) counts against the score.
  const events = rawEvents.filter((e) => e.skippedReason !== "unchanged");

  // Dedupe by productId: repeated retries of the same stuck SKU collapse into one failure.
  // A row with no productId (e.g. an OAuth/connection-level error) isn't tied to any one
  // listing, so each such row still counts on its own rather than merging with the others.
  const failedProductKeys = new Set(failures.map((f) => (f.productId ? `product:${f.productId}` : `row:${f.id}`)));

  const successCount = successes.length;
  const failureCount = failedProductKeys.size;
  const totalAttempts = successCount + failureCount;
  const totalEventCount = events.length;
  const outOfOrderEventCount = events.filter((e) => !e.applied).length;

  // Average only the components that actually have samples this window -- a component
  // with zero samples means "no evidence either way", not "clean", so it must not dilute
  // a bad score from the component that does have evidence. All-empty is the only case
  // that legitimately defaults to 100 (nothing has gone wrong because nothing has run).
  const components: number[] = [];
  if (totalAttempts > 0) components.push(Math.round((100 * successCount) / totalAttempts));
  if (totalEventCount > 0) components.push(Math.round((100 * (totalEventCount - outOfOrderEventCount)) / totalEventCount));
  const score = components.length === 0 ? 100 : Math.round(components.reduce((a, b) => a + b, 0) / components.length);

  return {
    channel,
    score,
    windowHours,
    successCount,
    failureCount,
    outOfOrderEventCount,
    totalEventCount,
  };
}
