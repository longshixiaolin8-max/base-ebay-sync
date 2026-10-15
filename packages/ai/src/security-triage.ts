import { z } from "zod";
import type { AIModelClient } from "./model-client.js";

/**
 * The Security Copilot receives ONLY fixed-dimension, aggregated CloudWatch
 * counters. Raw logs, requests, secrets, personal data, identity and IP addresses
 * are not part of the input contract. Never grant the model write-capable tools.
 */
export const SecurityEvent = z.enum([
  "ebay_signature_invalid",
  "ebay_destination_invalid",
  "stripe_signature_invalid",
  "operator_access_denied",
  "tenant_claim_missing",
  "cloudfront_origin_denied",
]);
export type SecurityEventType = z.infer<typeof SecurityEvent>;

const Window = z.object({
  eventType: SecurityEvent,
  count: z.number().int().min(0).max(1_000_000),
  windowMinutes: z.literal(5),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

/** Event type must be unique, so duplicated windows cannot bias risk scoring. */
const Windows = z.array(Window).max(6).superRefine((items, ctx) => {
  const known = new Set<SecurityEventType>();
  for (const [index, item] of items.entries()) {
    if (known.has(item.eventType)) {
      ctx.addIssue({ code: "custom", message: "duplicate eventType", path: [index, "eventType"] });
    }
    known.add(item.eventType);
  }
});
export type SecurityWindow = z.infer<typeof Window>;

const thresholds: Record<SecurityEventType, number> = {
  ebay_signature_invalid: 10,
  ebay_destination_invalid: 5,
  stripe_signature_invalid: 10,
  operator_access_denied: 3,
  tenant_claim_missing: 3,
  cloudfront_origin_denied: 10,
};

/** Human investigations only. No user bans, firewall edits, billing or IAM writes. */
const humanRunbooks: Record<SecurityEventType, string> = {
  ebay_signature_invalid: "Investigate eBay signature/key verification and source integrity",
  ebay_destination_invalid: "Inspect destination registration and possible URL tampering",
  stripe_signature_invalid: "Check Stripe endpoint signing secret and rejected delivery patterns",
  operator_access_denied: "Audit attempted operator access and signed-in identity",
  tenant_claim_missing: "Audit Cognito token claims and tenant membership configuration",
  cloudfront_origin_denied: "Verify origin secret and attempted direct API bypass",
};

export interface SecurityFinding {
  eventType: SecurityEventType;
  count: number;
  threshold: number;
  observedAt: string;
  severity: "high" | "critical";
  action: string;
}

export interface SecurityReport {
  version: 1;
  source: "rules";
  findings: SecurityFinding[];
  ai: { summary: string; hypotheses: string[] } | null;
}

/** Fail closed on unknown event types and unexpected fields. */
export function assessSecurityWindows(raw: unknown): SecurityReport {
  const windows = Windows.parse(raw);
  const findings = windows.flatMap((window): SecurityFinding[] => {
    const threshold = thresholds[window.eventType];
    if (window.count < threshold) return [];
    return [{
      eventType: window.eventType,
      count: window.count,
      threshold,
      observedAt: window.observedAt,
      severity: window.eventType === "tenant_claim_missing" || window.eventType === "operator_access_denied" ? "critical" : "high",
      action: humanRunbooks[window.eventType],
    }];
  });
  return { version: 1, source: "rules", findings, ai: null };
}

const AISummary = z.object({
  summary: z.string().trim().min(1).max(600),
  hypotheses: z.array(z.string().trim().min(1).max(180)).max(3),
}).strict();

/**
 * Optional model-assisted explanation; the rule findings and severity CANNOT
 * be altered by the model. No model call for healthy windows. If an AI
 * provider fails or returns invalid JSON, keep the deterministic report.
 */
export async function explainSecurityReport(
  raw: unknown,
  model?: Pick<AIModelClient, "generateJson">,
): Promise<SecurityReport> {
  const report = assessSecurityWindows(raw);
  if (report.findings.length === 0 || !model) return report;
  try {
    const proposed = await model.generateJson({
      system: [
        "You are a read-only security triage assistant.",
        "Your evidence is ONLY the aggregated counters below.",
        "Never claim compromise is proven from a threshold alone.",
        "Return JSON with summary (max 600 chars) and hypotheses (max 3).",
        "Do not invent IPs, tenants, users, logs, additional incidents or actions taken.",
        "Never propose automatic secret access, bans, deployments or charges.",
      ].join(" "),
      user: JSON.stringify({ source: "CloudWatchAggregatedCounters", findings: report.findings }),
    });
    const parsed = AISummary.safeParse(proposed);
    if (parsed.success) return { ...report, ai: parsed.data };
    return report;
  } catch {
    return report;
  }
}
