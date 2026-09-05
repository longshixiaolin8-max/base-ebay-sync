import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
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
export async function computeSyncConfidence(db: Database, channel: string, windowHours = 24): Promise<SyncConfidence> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const failures = await db
    .select()
    .from(syncErrors)
    .where(and(eq(syncErrors.channel, channel), gte(syncErrors.createdAt, since)));
  const successes = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.channel, channel), gte(channelListings.lastSyncedAt, since)));

  const rawEvents = await db
    .select()
    .from(inventoryEvents)
    .where(and(eq(inventoryEvents.channel, channel), gte(inventoryEvents.createdAt, since)));
  // A report equal to the current watermark just means "nothing changed since last poll" --
  // an ordinary, frequent outcome, not evidence of a sync problem. Only a genuine reversal
  // (skippedReason "out_of_order", strictly older than the watermark) counts against the score.
  const events = rawEvents.filter((e) => e.skippedReason !== "unchanged");

  const successCount = successes.length;
  const failureCount = failures.length;
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
