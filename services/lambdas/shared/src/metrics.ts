/**
 * Item #3 of the user's follow-up ask ("直接通知が来る仕組みがない"): nothing previously
 * surfaced a repeated sync failure or channel isolation to the user directly -- both were
 * only visible by opening the admin dashboard. `recordSyncError` already catches every sync
 * failure, and every poller already computes `isChannelIsolated`, so both hook straight into
 * CloudWatch via the Embedded Metric Format (EMF): a specially-shaped JSON log line that
 * CloudWatch Logs turns into a real metric with zero extra IAM permissions (Lambda already
 * has logs:PutLogEvents) and zero extra AWS SDK calls. MonitoringStack alarms on these same
 * metric names and forwards to the existing SNS topic / email subscription.
 */
function emitEmfMetric(metricName: string, dimensionValues: Record<string, string>, dimensionSets: string[][]): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "AiEcPlatform",
            Dimensions: dimensionSets,
            Metrics: [{ Name: metricName, Unit: "Count" }],
          },
        ],
      },
      ...dimensionValues,
      [metricName]: 1,
    }),
  );
}

/**
 * Emitted with two dimension sets from one log line: a Channel-only series (what
 * MonitoringStack alarms on -- "does this channel have a failure problem right now",
 * independent of which specific error it is) and a Channel+ErrorCode series (kept only for
 * ad-hoc CloudWatch Logs Insights/metric-explorer digging into *which* error is recurring).
 */
export function emitSyncErrorMetric(channel: string | null | undefined, errorCode: string): void {
  emitEmfMetric(
    "SyncErrors",
    { Channel: channel ?? "unknown", ErrorCode: errorCode },
    [["Channel"], ["Channel", "ErrorCode"]],
  );
}

export function emitChannelIsolatedMetric(channel: string): void {
  emitEmfMetric("ChannelIsolated", { Channel: channel }, [["Channel"]]);
}

/** Fixed-size, low-cardinality event taxonomy for security anomaly monitoring.
 * Never place IPs, emails, JWTs, request data or tokens in metric dimensions.
 * Deterministic detectors remain authoritative: AI can only summarize alerts. */
export type SecurityDenialType =
  | "ebay_signature_invalid"
  | "ebay_destination_invalid"
  | "stripe_signature_invalid"
  | "operator_access_denied"
  | "tenant_claim_missing"
  | "cloudfront_origin_denied";

export function emitSecurityDenialMetric(kind: SecurityDenialType): void {
  emitEmfMetric("SecurityDenials", { EventType: kind }, [["EventType"]]);
}
