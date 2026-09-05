import type { ChannelSyncState } from "@ai-ec/core";
import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { isChannelIsolated } from "./channel-isolation.js";
import { syncErrors } from "./schema.js";
import { computeSyncConfidence } from "./sync-confidence.js";

/** Below this computeSyncConfidence score (and not already isolated/reconciling), a channel
 *  is reported DEGRADED rather than HEALTHY. Deliberately higher than ebay-sync-worker's own
 *  SYNC_CONFIDENCE_PUBLISH_THRESHOLD (40) -- that one gates a specific risky action (new
 *  publishes), this one is just visibility, so it should flag a problem earlier. */
const DEGRADED_CONFIDENCE_THRESHOLD = 70;
/** inventory-diff-check runs every 6h (see infra/lib/lambda-stack.ts); a drift finding from
 *  its last run or two is still "current" evidence of unreconciled state. */
const RECONCILING_WINDOW_HOURS = 12;

export interface ChannelSyncStateResult {
  channel: string;
  state: ChannelSyncState;
  reasons: string[];
}

/**
 * Item #8 of the commercial-features round ("同期状態をState Machine化"). A pure
 * classification derived on every call from signals this platform already records --
 * isChannelIsolated (auth failure / sustained rate limiting), computeSyncConfidence (recent
 * error/reversal rate), and inventory-diff-check's own "inventory_drift" sync_errors finding
 * -- never a new persisted state to keep in sync with reality. Precedence, most severe first:
 * ISOLATED > RECONCILING > RECOVERING > DEGRADED > HEALTHY.
 */
export async function computeChannelSyncState(db: Database, channel: string): Promise<ChannelSyncStateResult> {
  const isolation = await isChannelIsolated(db, channel);
  if (isolation.isolated) {
    return { channel, state: "ISOLATED", reasons: isolation.reasons };
  }

  const reconcilingSince = new Date(Date.now() - RECONCILING_WINDOW_HOURS * 60 * 60 * 1000);
  const driftErrors = await db
    .select()
    .from(syncErrors)
    .where(and(eq(syncErrors.channel, channel), eq(syncErrors.errorCode, "inventory_drift"), gte(syncErrors.createdAt, reconcilingSince)));
  if (driftErrors.length > 0) {
    return {
      channel,
      state: "RECONCILING",
      reasons: [`inventory-diff-check found ${driftErrors.length} drifted product(s) for ${channel} in the last ${RECONCILING_WINDOW_HOURS}h`],
    };
  }

  // Isolation is stateless (see isChannelIsolated) -- re-checking with a wider window is how
  // "was isolated a moment ago, isn't now" gets detected without a separate persisted flag.
  const recentlyIsolated = await isChannelIsolated(db, channel, isolation.windowMinutes * 2);
  if (recentlyIsolated.isolated) {
    return {
      channel,
      state: "RECOVERING",
      reasons: [`${channel} was isolated within the last ${recentlyIsolated.windowMinutes}min but is not isolated right now`],
    };
  }

  const confidence = await computeSyncConfidence(db, channel);
  if (confidence.score < DEGRADED_CONFIDENCE_THRESHOLD) {
    return {
      channel,
      state: "DEGRADED",
      reasons: [`sync confidence score is ${confidence.score}/100 over the last ${confidence.windowHours}h`],
    };
  }

  return { channel, state: "HEALTHY", reasons: [] };
}
