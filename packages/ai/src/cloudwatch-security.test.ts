import { describe, expect, it } from "vitest";
import { parseSecurityMetricData, securityMetricRequest } from "./cloudwatch-security.js";
import { assessSecurityWindows } from "./security-triage.js";

const now = new Date("2026-10-15T07:12:34.000Z");

describe("read-only CloudWatch Security Copilot input", () => {
  it("only requests the six known counters for the last completed bucket", () => {
    const request = securityMetricRequest(now);
    expect(request.StartTime.toISOString()).toBe("2026-10-15T07:05:00.000Z");
    expect(request.EndTime.toISOString()).toBe("2026-10-15T07:10:00.000Z");
    expect(request.MetricDataQueries).toHaveLength(6);
    for (const q of request.MetricDataQueries) {
      expect(q.MetricStat.Metric.Namespace).toBe("AiEcPlatform");
      expect(q.MetricStat.Metric.MetricName).toBe("SecurityDenials");
      expect(q.MetricStat.Metric.Dimensions).toHaveLength(1);
      expect(q.MetricStat.Metric.Dimensions[0].Name).toBe("EventType");
      expect(q.MetricStat.Period).toBe(300);
    }
  });

  it("turns complete aggregate counters into actionable deterministic incidents", () => {
    const request = securityMetricRequest(now);
    const output = { MetricDataResults: request.MetricDataQueries.map(q => ({
      Id: q.Id, StatusCode: "Complete", Values: [q.MetricStat.Metric.Dimensions[0].Value === "operator_access_denied" ? 3 : 0],
    })) };
    const result = assessSecurityWindows(parseSecurityMetricData(output, request));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ eventType: "operator_access_denied", severity: "critical" });
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("treats missing observations as 0 for a complete bucket without fabricating observations", () => {
    const request = securityMetricRequest(now);
    const output = { MetricDataResults: request.MetricDataQueries.map(q => ({
      Id: q.Id, StatusCode: "Complete", Values: [],
    })) };
    const values = parseSecurityMetricData(output, request);
    expect(values.every(x => x.count === 0)).toBe(true);
    // This represents absence of published counts, NOT proof that data collection was active.
  });

  it("fails closed on missing, partial, duplicated, truncated, unsafe or multiple datapoints", () => {
    const request = securityMetricRequest(now);
    const complete = request.MetricDataQueries.map(q => ({ Id: q.Id, StatusCode: "Complete", Values: [0] }));
    for (const response of [
      { MetricDataResults: complete.slice(1) },
      { MetricDataResults: [...complete, complete[0]] },
      { MetricDataResults: complete, NextToken: "truncated" },
      { MetricDataResults: [{ ...complete[0], StatusCode: "PartialData" }, ...complete.slice(1)] },
      { MetricDataResults: [{ ...complete[0], Values: [-1] }, ...complete.slice(1)] },
      { MetricDataResults: [{ ...complete[0], Values: [1, 2] }, ...complete.slice(1)] },
    ]) {
      expect(() => parseSecurityMetricData(response, request)).toThrow();
    }
  });
});
