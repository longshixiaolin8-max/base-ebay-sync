import { describe, expect, it } from "vitest";
import { computeLearnedTargetMargin } from "./margin-learning.js";

describe("computeLearnedTargetMargin", () => {
  it("falls back to the configured default when there's no order history at all", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: null,
      sampleSize: 0,
      fallbackMarginRatio: 0.3,
      staleness: "fresh",
      highDemand: false,
    });

    expect(result.baselineSource).toBe("fallback_default");
    expect(result.baselineMarginRatio).toBe(0.3);
    expect(result.targetMarginRatio).toBe(0.3);
  });

  it("ignores a historical average below the minimum sample size, as too noisy to trust", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.5,
      sampleSize: 2,
      fallbackMarginRatio: 0.3,
      staleness: "fresh",
      highDemand: false,
    });

    expect(result.baselineSource).toBe("fallback_default");
    expect(result.targetMarginRatio).toBe(0.3);
  });

  it("uses the tenant's own realized average margin once there's enough history", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.22,
      sampleSize: 5,
      fallbackMarginRatio: 0.3,
      staleness: "fresh",
      highDemand: false,
    });

    expect(result.baselineSource).toBe("tenant_history");
    expect(result.baselineMarginRatio).toBe(0.22);
    expect(result.targetMarginRatio).toBe(0.22);
  });

  it("discounts a stale_30 product below its baseline to encourage a sale", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "stale_30",
      highDemand: false,
    });

    expect(result.targetMarginRatio).toBeCloseTo(0.27, 5);
    expect(result.adjustmentRatio).toBeCloseTo(-0.03, 5);
  });

  it("discounts a stale_90 product the most aggressively of the staleness tiers", () => {
    const stale60 = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "stale_60",
      highDemand: false,
    });
    const stale90 = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "stale_90",
      highDemand: false,
    });

    expect(stale90.targetMarginRatio).toBeLessThan(stale60.targetMarginRatio);
  });

  it("never recommends a margin below the hard floor, even for a deeply stale, low-baseline product", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.08,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "stale_90",
      highDemand: false,
    });

    expect(result.targetMarginRatio).toBe(0.05);
  });

  it("adds a small margin premium for a fresh, high-demand product instead of discounting it", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "fresh",
      highDemand: true,
    });

    expect(result.targetMarginRatio).toBeGreaterThan(0.3);
    expect(result.adjustmentReason).toContain("上乗せ");
  });

  it("never applies the high-demand premium to a product that's also stale -- it should clear, not get pricier", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "stale_30",
      highDemand: true,
    });

    expect(result.targetMarginRatio).toBeLessThan(0.3);
  });

  it("applies no adjustment to a fresh, ordinary-demand product", () => {
    const result = computeLearnedTargetMargin({
      historicalAvgMarginRatio: 0.3,
      sampleSize: 10,
      fallbackMarginRatio: 0.3,
      staleness: "fresh",
      highDemand: false,
    });

    expect(result.adjustmentRatio).toBe(0);
    expect(result.targetMarginRatio).toBe(0.3);
  });
});
