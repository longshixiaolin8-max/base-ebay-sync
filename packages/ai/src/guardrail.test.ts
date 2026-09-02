import { describe, expect, it } from "vitest";
import { AIOutputValidationError, enforceGuardrails } from "./guardrail.js";
import type { SourceProductFacts } from "./prompt.js";

const baseSource: SourceProductFacts = {
  titleJa: "レザーバッグ",
  descriptionJa: "used leather bag",
  brand: null,
  material: null,
  sizeLabel: null,
  priceJpy: 5000,
  imageCount: 3,
};

function validRawOutput(overrides: Record<string, unknown> = {}) {
  return {
    titleEn: "Leather Bag",
    descriptionHtmlEn: "<p>Leather bag</p>",
    categoryCandidates: [{ ebayCategoryId: "169291", label: "Bags" }],
    itemSpecifics: { Brand: "Coach", Material: null },
    seoKeywords: ["leather", "bag"],
    suggestedPriceUsd: 60,
    confidenceFlags: { brand: "confirmed", material: "unknown", size: "unknown", authenticity: "confirmed" },
    needsHumanReview: false,
    reviewNotes: [],
    ...overrides,
  };
}

describe("enforceGuardrails", () => {
  it("throws AIOutputValidationError for malformed model output", () => {
    expect(() => enforceGuardrails({ not: "valid" }, baseSource)).toThrow(AIOutputValidationError);
  });

  it("never allows authenticity to be reported as confirmed", () => {
    const result = enforceGuardrails(validRawOutput(), baseSource);
    expect(result.confidenceFlags.authenticity).toBe("uncertain");
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewNotes.some((n) => n.toLowerCase().includes("authenticity"))).toBe(true);
  });

  it("rejects a 'confirmed' brand claim when the source product had no brand field, and clears the value", () => {
    const result = enforceGuardrails(
      validRawOutput({ confidenceFlags: { brand: "confirmed", material: "unknown", size: "unknown", authenticity: "uncertain" } }),
      baseSource, // brand: null
    );
    expect(result.confidenceFlags.brand).toBe("unknown");
    expect(result.itemSpecifics.Brand).toBeNull();
  });

  it("accepts a 'confirmed' brand claim when the source product actually stated a brand", () => {
    const source: SourceProductFacts = { ...baseSource, brand: "Coach" };
    const result = enforceGuardrails(
      validRawOutput({ confidenceFlags: { brand: "confirmed", material: "unknown", size: "unknown", authenticity: "uncertain" } }),
      source,
    );
    expect(result.confidenceFlags.brand).toBe("confirmed");
    expect(result.itemSpecifics.Brand).toBe("Coach");
    // brand confirmed, but authenticity is still not confirmed -> still needs review
    expect(result.needsHumanReview).toBe(true);
  });

  it("forces needsHumanReview=true whenever any confidence flag is not confirmed", () => {
    const result = enforceGuardrails(
      validRawOutput({
        needsHumanReview: false,
        confidenceFlags: { brand: "unknown", material: "unknown", size: "unknown", authenticity: "unknown" },
      }),
      baseSource,
    );
    expect(result.needsHumanReview).toBe(true);
  });

  it("only allows needsHumanReview=false when every flag is confirmed AND authenticity was not model-confirmed (impossible) -> always true in practice", () => {
    // Because authenticity can never be model-confirmed, needsHumanReview can never end up false.
    const result = enforceGuardrails(
      validRawOutput({
        needsHumanReview: false,
        confidenceFlags: { brand: "confirmed", material: "confirmed", size: "confirmed", authenticity: "confirmed" },
      }),
      { ...baseSource, brand: "Coach", material: "Leather", sizeLabel: "One Size" },
    );
    expect(result.needsHumanReview).toBe(true);
  });
});
