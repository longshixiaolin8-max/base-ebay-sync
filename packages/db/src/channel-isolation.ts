import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { shouldThrottleChannel } from "./rate-control.js";
import { syncErrors } from "./schema.js";

export interface ChannelIsolationDecision {
  channel: string;
  isolated: boolean;
  reasons: string[];
  windowMinutes: number;
}

const DEFAULT_WINDOW_MINUTES = 15;
/** An OAuth failure needs a human to re-authenticate -- unlike a transient 429/5xx it will
 *  never self-heal by retrying, so even a single occurrence is enough to isolate the
 *  channel rather than waiting for a pattern to emerge (see getValidAccessToken). */
const AUTH_FAILURE_PATTERN = /access token.*expired|no refresh token is stored|no oauth connection stored/i;

/**
 * Item A of the third hardening round ("チャネル障害時の隔離モード -- eBay障害中は
 * eBayだけ自動隔離し、BASEは正常運用を継続"). A channel is isolated -- every scheduled
 * poll and every publish/update attempt for it skipped -- when either:
 *
 *  - a real authentication failure was recorded for it (expired token with no refresh
 *    token, or no OAuth connection at all), or
 *  - it looks rate-limited/unhealthy by the same real 429/5xx signal shouldThrottleChannel
 *    already uses (item #4 of the second hardening round).
 *
 * Deliberately stateless like that function -- no persisted "isolated" flag to remember to
 * clear. Once the underlying problem is actually fixed, the next probe (the failure ageing
 * out of the window) succeeds and isolation lifts on its own; until then this channel is
 * left alone and every *other* channel keeps operating exactly as if nothing were wrong.
 */
export async function isChannelIsolated(
  db: Database,
  channel: string,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
): Promise<ChannelIsolationDecision> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const reasons: string[] = [];

  const recentErrors = await db
    .select()
    .from(syncErrors)
    .where(and(eq(syncErrors.channel, channel), gte(syncErrors.createdAt, since)));
  if (recentErrors.some((e) => AUTH_FAILURE_PATTERN.test(e.errorMessage))) {
    reasons.push(
      `an authentication failure was recorded for ${channel} in the last ${windowMinutes}min -- this needs a ` +
        `human to re-authenticate, it will not resolve itself by retrying`,
    );
  }

  const throttle = await shouldThrottleChannel(db, channel, windowMinutes);
  reasons.push(...throttle.reasons);

  return { channel, isolated: reasons.length > 0, reasons, windowMinutes };
}
