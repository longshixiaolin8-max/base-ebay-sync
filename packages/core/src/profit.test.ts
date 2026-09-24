import { describe, expect, it } from "vitest";
import { computeOrderProfit, computeProfitVelocityUsdCentsPerDay, daysBetween, type OrderProfitInputs } from "./profit.js";

const baseInputs: OrderProfitInputs = {
  costJpy: null,
  salePriceJpy: null,
  salePriceUsdCents: null,
  ebayFeeUsdCents: null,
  paymentFeeUsdCents: null,
  shippingCostJpy: null,
  adSpendUsdCents: null,
  fxCostUsdCents: null,
  returnAmountUsdCents: null,
  usdPerJpy: 0.0067,
};

describe("computeOrderProfit", () => {
  it("computes net profit and margin for a typical eBay sale", () => {
    const result = computeOrderProfit({
      ...baseInputs,
      costJpy: 3000, // ~ $20.10 at 0.0067
      salePriceUsdCents: 5000, // $50.00
      ebayFeeUsdCents: 750, // 15%
      paymentFeeUsdCents: 145,
      shippingCostJpy: 800, // ~ $5.36
      adSpendUsdCents: 200,
      fxCostUsdCents: 50,
    });

    // cost = round(3000*0.0067*100) + round(800*0.0067*100) + 750 + 145 + 200 + 50
    //      = 2010 + 536 + 750 + 145 + 200 + 50 = 3691
    expect(result.revenueUsdCents).toBe(5000);
    expect(result.costUsdCents).toBe(3691);
    expect(result.netProfitUsdCents).toBe(1309);
    expect(result.profitMarginBasisPoints).toBe(Math.round((1309 / 5000) * 10000));
  });

  it("converts a BASE-side JPY sale price using the supplied FX rate", () => {
    const result = computeOrderProfit({ ...baseInputs, costJpy: 1000, salePriceJpy: 3000 });
    expect(result.revenueUsdCents).toBe(Math.round(3000 * 0.0067 * 100));
    expect(result.costUsdCents).toBe(Math.round(1000 * 0.0067 * 100));
  });

  it("prefers salePriceUsdCents over salePriceJpy when both happen to be set", () => {
    const result = computeOrderProfit({ ...baseInputs, salePriceUsdCents: 4000, salePriceJpy: 999999 });
    expect(result.revenueUsdCents).toBe(4000);
  });

  it("returns null margin when revenue is zero", () => {
    const result = computeOrderProfit(baseInputs);
    expect(result.revenueUsdCents).toBe(0);
    expect(result.profitMarginBasisPoints).toBeNull();
  });

  it("folds a return's refund in as a cost, without needing any other field to change", () => {
    const sold = computeOrderProfit({ ...baseInputs, salePriceUsdCents: 5000, ebayFeeUsdCents: 750 });
    const returned = computeOrderProfit({
      ...baseInputs,
      salePriceUsdCents: 5000,
      ebayFeeUsdCents: 750,
      returnAmountUsdCents: 5000,
    });
    expect(returned.netProfitUsdCents).toBe(sold.netProfitUsdCents - 5000);
  });

  it("is idempotent -- recomputing from the same stored fields twice never double-counts", () => {
    const inputs: OrderProfitInputs = { ...baseInputs, salePriceUsdCents: 5000, returnAmountUsdCents: 5000 };
    const first = computeOrderProfit(inputs);
    const second = computeOrderProfit(inputs);
    expect(second).toEqual(first);
  });
});

describe("daysBetween", () => {
  it("floors partial days", () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-03T12:00:00Z");
    expect(daysBetween(earlier, later)).toBe(2);
  });

  it("is 0 for the same day", () => {
    const t = new Date("2026-01-01T08:00:00Z");
    expect(daysBetween(t, t)).toBe(0);
  });

  it("clamps to 0 rather than going negative", () => {
    const earlier = new Date("2026-01-05T00:00:00Z");
    const later = new Date("2026-01-01T00:00:00Z");
    expect(daysBetween(earlier, later)).toBe(0);
  });
});

describe("computeProfitVelocityUsdCentsPerDay", () => {
  it("divides net profit by holding days", () => {
    expect(computeProfitVelocityUsdCentsPerDay(1000, 5)).toBe(200);
  });

  it("is null for a same-day sale (0 holding days)", () => {
    expect(computeProfitVelocityUsdCentsPerDay(1000, 0)).toBeNull();
  });

  it("handles a loss (negative net profit) the same as a gain", () => {
    expect(computeProfitVelocityUsdCentsPerDay(-1000, 5)).toBe(-200);
  });
});
