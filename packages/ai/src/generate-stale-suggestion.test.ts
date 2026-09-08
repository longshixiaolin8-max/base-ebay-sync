import { describe, expect, it } from "vitest";
import { suggestStaleProductImprovement } from "./generate-stale-suggestion.js";
import { AIOutputValidationError } from "./guardrail.js";
import type { AIModelClient } from "./model-client.js";
import type { SourceProductFacts } from "./prompt.js";

const source: SourceProductFacts = {
  titleJa: "ヴィンテージ シルバー ブレスレット",
  descriptionJa: "used, minor wear",
  brand: null,
  material: "silver",
  sizeLabel: null,
  priceJpy: 3000,
  imageCount: 3,
};

function fakeClient(response: unknown): AIModelClient {
  return { generateJson: async () => response };
}

describe("suggestStaleProductImprovement", () => {
  it("returns the parsed suggestion on a valid model response", async () => {
    const result = await suggestStaleProductImprovement(
      fakeClient({ suggestion: "Cut the price and add more photos.", suggestedActions: ["Cut price by 15%", "Add 2 more photos"] }),
      source,
      45,
    );
    expect(result.suggestion).toContain("price");
    expect(result.suggestedActions).toHaveLength(2);
  });

  it("throws AIOutputValidationError when the model response doesn't match the schema", async () => {
    await expect(suggestStaleProductImprovement(fakeClient({ suggestion: "" }), source, 45)).rejects.toThrow(
      AIOutputValidationError,
    );
  });
});
