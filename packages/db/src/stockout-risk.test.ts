import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { predictStockoutRisk } from "./stockout-risk.js";

/** predictStockoutRisk() selects in order: inventory_master, then inventory_events. */
function fakeDb(inventory: unknown, sales: Array<{ quantityDelta?: number }>): Database {
  const sequence = [inventory ? [inventory] : [], sales];
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => sequence[call++],
          then: (resolve: (v: unknown) => void) => resolve(sequence[call++]),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("predictStockoutRisk", () => {
  it("is not high risk with no measurable sales velocity", async () => {
    const result = await predictStockoutRisk(fakeDb({ quantity: 5 }, []), "p1");

    expect(result.highRisk).toBe(false);
    expect(result.daysUntilStockout).toBeNull();
    expect(result.salesPerDay).toBe(0);
  });

  it("is not high risk when already at zero — that's an actual sellout, not a prediction", async () => {
    const result = await predictStockoutRisk(fakeDb({ quantity: 0 }, [{ quantityDelta: 5 }]), "p1");

    expect(result.highRisk).toBe(false);
    expect(result.daysUntilStockout).toBeNull();
  });

  it("flags high risk when the current pace would sell out within the threshold", async () => {
    // 21 units sold over 7 days -> 3/day; 2 units left -> 2/3 = 0.67 days < 3-day threshold
    const sales = Array.from({ length: 21 }, () => ({ quantityDelta: 1 }));
    const result = await predictStockoutRisk(fakeDb({ quantity: 2 }, sales), "p1");

    expect(result.salesPerDay).toBe(3);
    expect(result.daysUntilStockout).toBeCloseTo(0.667, 2);
    expect(result.highRisk).toBe(true);
  });

  it("does not flag risk for a slow-moving product with plenty of runway", async () => {
    // 7 units sold over 7 days -> 1/day; 30 units left -> 30 days, well above the threshold
    const sales = Array.from({ length: 7 }, () => ({ quantityDelta: 1 }));
    const result = await predictStockoutRisk(fakeDb({ quantity: 30 }, sales), "p1");

    expect(result.daysUntilStockout).toBe(30);
    expect(result.highRisk).toBe(false);
  });

  it("treats a product with no inventory_master row as having nothing to protect", async () => {
    const result = await predictStockoutRisk(fakeDb(undefined, [{ quantityDelta: 5 }]), "p1");

    expect(result.currentQuantity).toBe(0);
    expect(result.highRisk).toBe(false);
  });
});
