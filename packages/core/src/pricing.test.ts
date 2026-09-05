import { describe, expect, it } from "vitest";
import { computeDynamicPrice } from "./pricing.js";

describe("computeDynamicPrice", () => {
  it("solves a price whose net proceeds hit exactly the target margin after real eBay fees and shipping", () => {
    const result = computeDynamicPrice({
      costJpy: 10000,
      fxRateUsdPerJpy: 0.0067,
      shippingUsd: 15,
      targetMarginRatio: 0.3,
    });

    // costUsd = 67; P = (67*1.3 + 15 + 0.40) / 0.85 ≈ 102.5 / 0.85 ≈ 120.59
    expect(result.costUsd).toBeCloseTo(67, 2);
    expect(result.recommendedPriceUsd).toBeCloseTo(120.59, 1);
    expect(result.netMarginRatio).toBeCloseTo(0.3, 2);
  });

  it("recovers exactly the target margin: net proceeds minus cost, over cost", () => {
    const result = computeDynamicPrice({
      costJpy: 20000,
      fxRateUsdPerJpy: 0.0068,
      shippingUsd: 8,
      targetMarginRatio: 0.5,
    });

    const expectedNet = result.costUsd * 1.5;
    expect(result.netProceedsUsd).toBeCloseTo(expectedNet, 1);
  });

  it("charges the eBay fee against the full recommended price, not just the cost", () => {
    const result = computeDynamicPrice({
      costJpy: 10000,
      fxRateUsdPerJpy: 0.0067,
      shippingUsd: 0,
      targetMarginRatio: 0.3,
    });

    expect(result.ebayFeeUsd).toBeCloseTo(result.recommendedPriceUsd * 0.15 + 0.4, 2);
  });

  it("uses a custom fee ratio and per-order fee when provided instead of the jewelry defaults", () => {
    const jewelry = computeDynamicPrice({ costJpy: 10000, fxRateUsdPerJpy: 0.0067, shippingUsd: 0, targetMarginRatio: 0.3 });
    const lowerFee = computeDynamicPrice({
      costJpy: 10000,
      fxRateUsdPerJpy: 0.0067,
      shippingUsd: 0,
      targetMarginRatio: 0.3,
      ebayFeeRatio: 0.1,
      ebayPerOrderFeeUsd: 0.3,
    });

    expect(lowerFee.recommendedPriceUsd).toBeLessThan(jewelry.recommendedPriceUsd);
  });

  it("adds more to the recommended price when shipping cost is higher", () => {
    const noShipping = computeDynamicPrice({ costJpy: 10000, fxRateUsdPerJpy: 0.0067, shippingUsd: 0, targetMarginRatio: 0.3 });
    const withShipping = computeDynamicPrice({
      costJpy: 10000,
      fxRateUsdPerJpy: 0.0067,
      shippingUsd: 20,
      targetMarginRatio: 0.3,
    });

    expect(withShipping.recommendedPriceUsd).toBeGreaterThan(noShipping.recommendedPriceUsd);
  });
});
