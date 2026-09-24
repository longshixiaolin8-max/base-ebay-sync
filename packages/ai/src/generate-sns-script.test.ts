import { describe, expect, it } from "vitest";
import { generateSnsScript } from "./generate-sns-script.js";
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

describe("generateSnsScript", () => {
  it("returns the parsed script on a valid model response", async () => {
    const result = await generateSnsScript(
      fakeClient({ scriptText: "Check out this vintage silver bracelet!", needsHumanReview: true, reviewNotes: [] }),
      source,
    );
    expect(result.scriptText).toContain("bracelet");
    expect(result.needsHumanReview).toBe(true);
  });

  it("throws AIOutputValidationError when the model response doesn't match the schema", async () => {
    await expect(generateSnsScript(fakeClient({ scriptText: "" }), source)).rejects.toThrow(AIOutputValidationError);
  });
});
