import { z } from "zod";
import { SecurityEvent, type SecurityEventType, type SecurityWindow } from "./security-triage.js";

export const PERIOD_SECONDS = 300;
const PERIOD_MS = PERIOD_SECONDS * 1000;
const EVENTS = SecurityEvent.options;

export interface SecurityMetricQuery {
  Id: string;
  MetricStat: {
    Metric: {
      Namespace: "AiEcPlatform";
      MetricName: "SecurityDenials";
      Dimensions: [{ Name: "EventType"; Value: SecurityEventType }];
    };
    Period: 300;
    Stat: "Sum";
  };
  ReturnData: true;
}
export interface SecurityCloudWatchRequest {
  MetricDataQueries: SecurityMetricQuery[];
  StartTime: Date;
  EndTime: Date;
  MaxDatapoints: number;
}

/** Query only the most recently completed five-minute bucket, never a sliding
 * and potentially incomplete minute. Identifiers/dimensions are a fixed enum,
 * not caller-defined input, and no raw logs or PII are requested. */
export function securityMetricRequest(now: Date): SecurityCloudWatchRequest {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid current time");
  const end = new Date(Math.floor(now.getTime() / PERIOD_MS) * PERIOD_MS);
  return {
    StartTime: new Date(end.getTime() - PERIOD_MS),
    EndTime: end,
    MaxDatapoints: EVENTS.length,
    MetricDataQueries: EVENTS.map((eventType, i) => ({
      Id: `m${i}`,
      MetricStat: {
        Metric: {
          Namespace: "AiEcPlatform",
          MetricName: "SecurityDenials",
          Dimensions: [{ Name: "EventType", Value: eventType }],
        },
        Period: PERIOD_SECONDS,
        Stat: "Sum",
      },
      ReturnData: true,
    })),
  };
}

const ApiResponse = z.object({
  NextToken: z.string().optional(),
  MetricDataResults: z.array(z.object({
    Id: z.string(),
    StatusCode: z.string().optional(),
    Values: z.array(z.number()).optional(),
  })).max(6),
});

/** Conversion is strict: incomplete/truncated/ambiguous CloudWatch data must
 * fail instead of being shown as a reassuring "0 security events". */
export function parseSecurityMetricData(
  response: unknown,
  query: SecurityCloudWatchRequest,
): SecurityWindow[] {
  const data = ApiResponse.parse(response);
  if (data.NextToken) throw new Error("CloudWatch result truncated");
  const byId = new Map(data.MetricDataResults.map(result => [result.Id, result]));
  if (byId.size !== data.MetricDataResults.length) throw new Error("Duplicate CloudWatch query ID");
  if (byId.size !== query.MetricDataQueries.length) throw new Error("Missing security metric");
  const observedAt = query.EndTime.toISOString();
  return query.MetricDataQueries.map((q): SecurityWindow => {
    const result = byId.get(q.Id);
    if (!result || result.StatusCode !== "Complete" || !result.Values || result.Values.length > 1) {
      throw new Error("Incomplete or unexpected CloudWatch security metric");
    }
    const count = result.Values[0] ?? 0; // Empty Values is normal for no events in this bucket.
    if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) {
      throw new Error("Invalid security metric count");
    }
    return { eventType: q.MetricStat.Metric.Dimensions[0].Value, count, observedAt, windowMinutes: 5 };
  });
}
