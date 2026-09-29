import { describe, expect, it } from "vitest";
import { classifyInventoryDiffMagnitude } from "./inventory-status.js";

describe("classifyInventoryDiffMagnitude", () => {
  it("classifies a small drift as normal", () => {
    expect(classifyInventoryDiffMagnitude(0)).toBe("normal");
    expect(classifyInventoryDiffMagnitude(2)).toBe("normal");
    expect(classifyInventoryDiffMagnitude(-2)).toBe("normal");
  });

  it("classifies a larger drift as attention, in either direction", () => {
    expect(classifyInventoryDiffMagnitude(3)).toBe("attention");
    expect(classifyInventoryDiffMagnitude(-5)).toBe("attention");
  });
});
