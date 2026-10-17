import { describe, expect, it } from "vitest";
import { assessDdpRequirement } from "./ddp-compliance.js";

const AFTER_EFFECTIVE = new Date("2026-01-01T00:00:00Z");
const BEFORE_EFFECTIVE = new Date("2025-01-01T00:00:00Z");

describe("assessDdpRequirement", () => {
  it("flags a US-bound eBay order under $2,500 placed after the policy's effective date", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: 15_000,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("required");
  });

  it("does not flag a BASE order regardless of destination", () => {
    const result = assessDdpRequirement({
      channel: "base",
      shipToCountryCode: "US",
      salePriceUsdCents: 15_000,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("not_required");
  });

  it("does not flag an order placed before the policy's effective date", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: 15_000,
      quantity: 1,
      placedAt: BEFORE_EFFECTIVE,
    });
    expect(result.status).toBe("not_required");
  });

  it("does not flag a non-US destination", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "GB",
      salePriceUsdCents: 15_000,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("not_required");
  });

  it("does not flag an order at or above the $2,500 threshold", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: 250_000,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("not_required");
  });

  it("reports unknown when the destination country is missing rather than assuming not required", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: null,
      salePriceUsdCents: 15_000,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("unknown");
  });

  it("reports unknown when the sale price is missing rather than assuming not required", () => {
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: null,
      quantity: 1,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("unknown");
  });

  it("flags a multi-unit line item by its per-unit price, not its line total", () => {
    // Two $1,500 units: each unit is under the $2,500 threshold and must be flagged, even
    // though the $3,000 line total alone would clear it.
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: 300_000,
      quantity: 2,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("required");
  });

  it("does not flag a multi-unit line item whose per-unit price clears the threshold", () => {
    // Two $2,600 units: $5,200 total, correctly not required since each unit individually
    // clears the $2,500 threshold.
    const result = assessDdpRequirement({
      channel: "ebay",
      shipToCountryCode: "US",
      salePriceUsdCents: 520_000,
      quantity: 2,
      placedAt: AFTER_EFFECTIVE,
    });
    expect(result.status).toBe("not_required");
  });
});
