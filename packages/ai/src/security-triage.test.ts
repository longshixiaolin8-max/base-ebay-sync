import { describe, expect, it, vi } from "vitest";
import { assessSecurityWindows, explainSecurityReport } from "./security-triage.js";

const at = "2026-10-15T12:00:00+09:00";
const sample = (eventType: string, count: number) => ({ eventType, count, windowMinutes: 5, observedAt: at });

describe("read-only Security Copilot", () => {
  it("reports deterministic alert severity at the configured thresholds", () => {
    const report = assessSecurityWindows([sample("operator_access_denied", 3), sample("ebay_signature_invalid", 9)]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ eventType: "operator_access_denied", count: 3, severity: "critical" });
    expect(report.ai).toBeNull();
  });

  it("refuses unknown event types, PII fields, duplicate windows and unbounded counts", () => {
    expect(() => assessSecurityWindows([sample("untrusted_user_email", 12)])).toThrow();
    expect(() => assessSecurityWindows([{ ...sample("ebay_destination_invalid", 6), token: "secret" }])).toThrow();
    expect(() => assessSecurityWindows([sample("operator_access_denied", 3), sample("operator_access_denied", 4)])).toThrow();
    expect(() => assessSecurityWindows([sample("operator_access_denied", 1_000_001)])).toThrow();
  });

  it("does not call an LLM when no threshold is breached", async () => {
    const model = { generateJson: vi.fn() };
    const report = await explainSecurityReport([sample("ebay_signature_invalid", 1)], model);
    expect(report.ai).toBeNull();
    expect(model.generateJson).not.toHaveBeenCalled();
  });

  it("enriches the explanation but never lets the model change severity/actions", async () => {
    const model = { generateJson: vi.fn().mockResolvedValue({
      summary: "Repeated operator authorization denials should be investigated.",
      hypotheses: ["Configuration drift", "Attempted abuse"],
      severity: "low",
    }) };
    const first = await explainSecurityReport([sample("operator_access_denied", 3)], model);
    expect(first.findings[0]?.severity).toBe("critical");
    // Unknown AI output keys fail schema validation, so a malicious or outdated
    // model cannot silently add instructions or demote an incident.
    expect(first.ai).toBeNull();
    model.generateJson.mockResolvedValueOnce({
      summary: "Repeated authorization denials warrant investigation.",
      hypotheses: ["Unexpected operator access attempts"],
    });
    const second = await explainSecurityReport([sample("operator_access_denied", 3)], model);
    expect(second.ai?.hypotheses).toHaveLength(1);
    expect(second.findings[0]?.severity).toBe("critical");
    const prompt = model.generateJson.mock.calls.at(-1)?.[0]?.user as string;
    expect(prompt).not.toContain("secret");
    expect(prompt).toContain("CloudWatchAggregatedCounters");
  });

  it("returns rule findings if the optional AI provider fails", async () => {
    const report = await explainSecurityReport([sample("stripe_signature_invalid", 10)],
      { generateJson: vi.fn().mockRejectedValue(new Error("provider unavailable")) });
    expect(report.ai).toBeNull();
    expect(report.findings).toHaveLength(1);
  });
});
