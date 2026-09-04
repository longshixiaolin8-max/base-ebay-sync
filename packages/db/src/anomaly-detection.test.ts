import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { detectInventoryAnomaly, detectPriceAnomaly } from "./anomaly-detection.js";

function fakeDb(events: unknown[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => events,
        }),
      }),
    }),
  } as unknown as Database;
}

describe("detectInventoryAnomaly", () => {
  it("is not anomalous with no recent events", async () => {
    const result = await detectInventoryAnomaly(fakeDb([]), "p1");

    expect(result.anomalous).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("flags more than the threshold number of sale events as a mass-order burst", async () => {
    const events = Array.from({ length: 6 }, () => ({ eventType: "sale", quantityDelta: 1, applied: true }));
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(true);
    expect(result.saleEventCount).toBe(6);
    expect(result.reasons[0]).toMatch(/6 sale events/);
  });

  it("does not flag a normal handful of sale events", async () => {
    const events = Array.from({ length: 3 }, () => ({ eventType: "sale", quantityDelta: 1, applied: true }));
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(false);
  });

  it("flags a single abnormally large sale event", async () => {
    const events = [{ eventType: "sale", quantityDelta: 15, applied: true }];
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(true);
    expect(result.maxSingleSaleQuantity).toBe(15);
    expect(result.reasons[0]).toMatch(/15 units/);
  });

  it("flags a BASE stock report that swings the absolute quantity by more than the threshold", async () => {
    const events = [
      { eventType: "base_stock_report", absoluteQuantity: 10, applied: true },
      { eventType: "base_stock_report", absoluteQuantity: 1, applied: true },
    ];
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(true);
    expect(result.reasons[0]).toMatch(/swung 90%/);
  });

  it("does not flag a routine restock-sized swing", async () => {
    const events = [
      { eventType: "base_stock_report", absoluteQuantity: 10, applied: true },
      { eventType: "base_stock_report", absoluteQuantity: 8, applied: true },
    ];
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(false);
  });

  it("treats a legitimate sellout (drop to 0) via sale events as normal, not a swing anomaly", async () => {
    const events = [{ eventType: "sale", quantityDelta: 3, applied: true }];
    const result = await detectInventoryAnomaly(fakeDb(events), "p1");

    expect(result.anomalous).toBe(false);
  });
});

describe("detectPriceAnomaly", () => {
  it("is never anomalous when there is no prior synced price", () => {
    const result = detectPriceAnomaly(null, 999999);
    expect(result.anomalous).toBe(false);
  });

  it("is not anomalous for an ordinary price adjustment", () => {
    const result = detectPriceAnomaly(10000, 12000);
    expect(result.anomalous).toBe(false);
  });

  it("flags a price that swings more than the threshold versus the last synced price", () => {
    const result = detectPriceAnomaly(10000, 1000);
    expect(result.anomalous).toBe(true);
    expect(result.reason).toMatch(/90%/);
  });

  it("flags a large price increase too, not just a drop", () => {
    const result = detectPriceAnomaly(1000, 10000);
    expect(result.anomalous).toBe(true);
  });
});
