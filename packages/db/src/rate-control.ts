import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { syncErrors } from "./schema.js";

export interface ThrottleDecision {
  channel: string;
  throttle: boolean;
  reasons: string[];
  windowMinutes: number;
  apiErrorCount: number;
}

const DEFAULT_WINDOW_MINUTES = 15;
/** BASE/eBay adapter errors format their message as "<Channel> API error <status>: <body>"
 *  (see EbayApiError/BaseApiError) -- the only reliable way to tell "this channel's own API
 *  call failed" apart from an unrelated failure that merely happens to be tagged with the
 *  same channel. Confirmed live: ai-generate-worker records Bedrock quota errors with
 *  channel:"ebay" too (since they block an eBay listing), and they had been dragging this
 *  channel's general sync-confidence score toward 0 for a reason that says nothing about
 *  eBay's own API health -- reusing that score here would have throttled real sale polling
 *  over an unrelated AI-quota outage. This matches only the adapters' own error format.
 */
const API_ERROR_STATUS_PATTERN = /API error (\d{3}):/;
/** Only 429 (explicit rate limit) and 5xx (server-side trouble) are evidence the channel's
 *  own API needs a break. A 4xx other than 429 is a malformed-request bug on our side --
 *  also confirmed live (stale, already-fixed condition/aspect validation errors) -- and
 *  slowing down the poll schedule would not fix it, so those never count here. */
function isRateOrAvailabilitySignal(status: number): boolean {
  return status === 429 || status >= 500;
}
/** 3+ genuine API-health failures in the window looks like real trouble, not one-off noise. */
const ERROR_COUNT_THROTTLE_THRESHOLD = 3;

/**
 * Item #4 of the second hardening round ("チャネル別レート制御 -- BASE/eBay APIの制限・
 * 遅延に応じて同期頻度を自動変更"). There is no real per-call API-latency metric recorded
 * anywhere in this platform (same constraint noted in computeDynamicSafetyStock), and the
 * scheduled pollers' EventBridge cron expressions are declared by CDK -- mutating them at
 * runtime would just get overwritten on the next deploy and fight the infrastructure that
 * owns them. So instead of rewriting a schedule, this decides whether one particular
 * invocation should skip polling a channel this cycle: a real 429/5xx recorded against that
 * channel's own adapter calls throttles the *effective* polling frequency down without
 * touching the declared schedule.
 */
export async function shouldThrottleChannel(
  db: Database,
  channel: string,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
): Promise<ThrottleDecision> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);
  const reasons: string[] = [];

  const recentErrors = await db
    .select()
    .from(syncErrors)
    .where(and(eq(syncErrors.channel, channel), gte(syncErrors.createdAt, since)));

  const apiStatuses = recentErrors
    .map((e) => e.errorMessage.match(API_ERROR_STATUS_PATTERN)?.[1])
    .filter((s): s is string => s !== undefined)
    .map(Number)
    .filter(isRateOrAvailabilitySignal);

  if (apiStatuses.includes(429)) {
    reasons.push(`a 429 (rate limited) response was recorded for ${channel}'s own API in the last ${windowMinutes}min`);
  }
  if (apiStatuses.length >= ERROR_COUNT_THROTTLE_THRESHOLD) {
    reasons.push(
      `${apiStatuses.length} ${channel} API rate-limit/server-error responses recorded in the last ` +
        `${windowMinutes}min (threshold ${ERROR_COUNT_THROTTLE_THRESHOLD})`,
    );
  }

  return { channel, throttle: reasons.length > 0, reasons, windowMinutes, apiErrorCount: apiStatuses.length };
}
