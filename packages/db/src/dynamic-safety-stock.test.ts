import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./client.js";

const computeSyncConfidenceMock = vi.fn();
vi.mock("./sync-confidence.js", () => ({
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
}));

const { computeDynamicSafetyStock } = await import("./dynamic-safety-stock.js");

function fakeDb(sales: Array<{ quantityDelta?: number }>): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => sales,
      }),
    }),
  } as unknown as Database;
}

describe("computeDynamicSafetyStock", () => {
  beforeEach(() => computeSyncConfidenceMock.mockReset());

  it("recommends 0 when there have been no sales at all", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 100,
      windowHours: 24,
      successCount: 0,
      failureCount: 0,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });

    const result = await computeDynamicSafetyStock(fakeDb([]), "p1", "ebay");

    expect(result.recommendedBuffer).toBe(0);
    expect(result.salesPerDay).toBe(0);
  });

  it("scales the buffer with sales velocity when confidence is high", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 100,
      windowHours: 24,
      successCount: 5,
      failureCount: 0,
      outOfOrderEventCount: 0,
      totalEventCount: 5,
    });
    // 140 units sold over the default 7-day window -> 20/day -> at a 60-minute poll cycle,
    // expected sales per cycle = 20 * (60/1440) = 0.833 -> riskMultiplier 1 (score>=80) -> ceil(0.833) = 1
    const sales = Array.from({ length: 14 }, () => ({ quantityDelta: 10 }));

    const result = await computeDynamicSafetyStock(fakeDb(sales), "p1", "ebay", { pollIntervalMinutes: 60 });

    expect(result.salesPerDay).toBe(20);
    expect(result.riskMultiplier).toBe(1);
    expect(result.recommendedBuffer).toBe(1);
  });

  it("widens the buffer when the channel's sync confidence is low", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 30,
      windowHours: 24,
      successCount: 1,
      failureCount: 5,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });
    const sales = Array.from({ length: 14 }, () => ({ quantityDelta: 10 })); // same 20/day as above

    const result = await computeDynamicSafetyStock(fakeDb(sales), "p1", "ebay", { pollIntervalMinutes: 60 });

    expect(result.confidenceScore).toBe(30);
    expect(result.riskMultiplier).toBe(2);
    // expected per cycle 0.833 * 2 = 1.67 -> ceil -> 2, vs. 1 at full confidence above
    expect(result.recommendedBuffer).toBe(2);
  });

  it("never recommends a negative buffer", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 100,
      windowHours: 24,
      successCount: 0,
      failureCount: 0,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });

    const result = await computeDynamicSafetyStock(fakeDb([]), "p1", "ebay");

    expect(result.recommendedBuffer).toBeGreaterThanOrEqual(0);
  });
});
