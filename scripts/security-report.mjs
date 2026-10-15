#!/usr/bin/env node
/**
 * Explicit, one-shot, READ-ONLY security incident snapshot.
 * Requires AWS CLI v2 and built workspace packages: pnpm build.
 * Example: AWS_PROFILE=security-audit AWS_REGION=us-east-2 pnpm security:report
 * No AWS permissions are changed, and no model inference is invoked.
 * CloudWatch GetMetricData requests may incur metered charges.
 */
import { execFileSync } from "node:child_process";
import { assessSecurityWindows } from "../packages/ai/dist/security-triage.js";
import { securityMetricRequest, parseSecurityMetricData } from "../packages/ai/dist/cloudwatch-security.js";

const region = process.env.AWS_REGION ?? "us-east-2";
if (!/^[a-z]{2}-[a-z-]+-\d+$/.test(region)) {
  console.error("Invalid AWS_REGION");
  process.exit(2);
}

try {
  const request = securityMetricRequest(new Date());
  const result = execFileSync("aws", [
    "cloudwatch", "get-metric-data",
    "--region", region,
    "--metric-data-queries", JSON.stringify(request.MetricDataQueries),
    "--start-time", request.StartTime.toISOString(),
    "--end-time", request.EndTime.toISOString(),
    "--max-datapoints", String(request.MaxDatapoints),
    "--output", "json",
  ], {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, AWS_PAGER: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const windows = parseSecurityMetricData(JSON.parse(result), request);
  const findings = assessSecurityWindows(windows);
  process.stdout.write(JSON.stringify({
    interval: { start: request.StartTime.toISOString(), end: request.EndTime.toISOString() },
    region,
    readings: windows,
    report: findings,
    limitations: "An empty metric is not proof that CloudWatch/EMF delivery is deployed or healthy.",
  }, null, 2) + "\n");
  if (findings.findings.length > 0) process.exitCode = 1;
} catch {
  console.error("Read-only CloudWatch snapshot failed. Verify AWS CLI/profile, cloudwatch:GetMetricData permission, build outputs and metric freshness.");
  process.exitCode = 2;
}
