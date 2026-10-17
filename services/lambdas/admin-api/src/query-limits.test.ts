import { describe, expect, it } from "vitest";
import { boundedDashboardLimit } from "./query-limits.js";

describe("boundedDashboardLimit", () => {
  it("keeps the default and valid positive bounded integers", () => {
    expect(boundedDashboardLimit(undefined, 30, 100)).toBe(30);
    expect(boundedDashboardLimit("1", 30, 100)).toBe(1);
    expect(boundedDashboardLimit("100", 30, 100)).toBe(100);
  });

  it("rejects Infinity, large queries, decimals, negative, non-numeric and zero", () => {
    for (const raw of ["-1", "0", "1000", "101", "1.5", "NaN", "Infinity", "1e9", "1foo", "", "0001"]) {
      expect(boundedDashboardLimit(raw, 30, 100)).toBeNull();
    }
  });
});
