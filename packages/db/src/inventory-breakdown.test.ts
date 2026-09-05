import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { getInventoryBreakdown } from "./inventory-breakdown.js";

describe("getInventoryBreakdown", () => {
  it("returns null when the product or inventory row is missing", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Database;

    const result = await getInventoryBreakdown(db, "product-1");
    expect(result).toBeNull();
  });

  it("maps on_hand/available to inventory_master.quantity and safety_buffer to the existing column, without subtracting reserved", async () => {
    let call = 0;
    // Call order matches getInventoryBreakdown's implementation exactly: product_master and
    // inventory_master are read with an explicit .limit(1), reserved orders and channel
    // listings are awaited directly off .where() (no .limit()) -- a thenable stands in for
    // that, so `await db.select().from(x).where(...)` resolves without a .limit() call.
    const responses: unknown[][] = [
      [{ id: "product-1", sourceChannel: "base" }], // product_master
      [{ quantity: 5, safetyStockBuffer: 1 }], // inventory_master
      [
        { quantity: 2, status: "PAID" },
        { quantity: 1, status: "ORDER_RECEIVED" },
      ], // reserved orders
      [{ channel: "base" }, { channel: "ebay" }], // channel_listings
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => responses[call++]!,
            then: (resolve: (v: unknown) => void) => resolve(responses[call++]!),
          }),
        }),
      }),
    } as unknown as Database;

    const result = await getInventoryBreakdown(db, "product-1");

    expect(result).not.toBeNull();
    expect(result!.onHand).toBe(5);
    expect(result!.available).toBe(5); // NOT reduced by reserved -- applySale already did that
    expect(result!.safetyBuffer).toBe(1);
    expect(result!.reserved).toBe(3); // 2 + 1
    expect(result!.sellableByChannel.base).toBe(5); // source channel: unbuffered
    expect(result!.sellableByChannel.ebay).toBe(4); // secondary channel: 5 - 1 buffer
  });
});
