import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  finalizeOrderProfit,
  getLiveOrderProfit,
  InvalidOrderTransitionError,
  listOrders,
  listOrdersForProduct,
  listReservedOrdersForProduct,
  transitionOrderStatus,
  upsertOrderReceived,
  type OrderRow,
} from "./orders.js";

function baseOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    productId: "product-1",
    channel: "ebay",
    externalOrderId: "ext-1",
    quantity: 1,
    status: "ORDER_RECEIVED",
    costJpy: null,
    salePriceJpy: null,
    salePriceUsdCents: null,
    ebayFeeUsdCents: null,
    paymentFeeUsdCents: null,
    shippingCostJpy: null,
    adSpendUsdCents: null,
    fxCostUsdCents: null,
    returnAmountUsdCents: null,
    finalizedNetProfitUsdCents: null,
    profitFinalizedAt: null,
    placedAt: new Date("2026-01-01T00:00:00Z"),
    paidAt: null,
    allocatedAt: null,
    shippedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    returnRequestedAt: null,
    returnedAt: null,
    refundedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as OrderRow;
}

describe("upsertOrderReceived", () => {
  it("inserts a new order and returns the row read back", async () => {
    let inserted: unknown;
    const existing: OrderRow[] = [];
    const db = {
      insert: () => ({
        values: (v: unknown) => {
          inserted = v;
          return { onConflictDoNothing: async () => undefined };
        },
      }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => existing.length ? existing : [{ ...(inserted as object) }] }) }) }),
    } as unknown as Database;

    const row = await upsertOrderReceived(db, {
      productId: "product-1",
      channel: "ebay",
      externalOrderId: "ext-1",
      quantity: 2,
      placedAt: new Date("2026-01-01T00:00:00Z"),
    });

    expect((row as unknown as { status: string }).status).toBe("ORDER_RECEIVED");
    expect(inserted).toMatchObject({ channel: "ebay", externalOrderId: "ext-1", productId: "product-1" });
  });

  it("is idempotent -- a duplicate delivery reads back the already-existing row instead of inserting a second one", async () => {
    const existingRow = baseOrder({ status: "SHIPPED" }); // already progressed past ORDER_RECEIVED
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existingRow] }) }) }),
    } as unknown as Database;

    const row = await upsertOrderReceived(db, {
      productId: "product-1",
      channel: "ebay",
      externalOrderId: "ext-1",
      quantity: 2,
      placedAt: new Date(),
    });

    // Must return the real, already-progressed row -- never silently reset it to ORDER_RECEIVED.
    expect(row.status).toBe("SHIPPED");
  });
});

function fakeOrderDb(current: OrderRow): { db: Database; getSet: () => Record<string, unknown> | undefined } {
  let capturedSet: Record<string, unknown> | undefined;
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        capturedSet = values;
        return {
          where: () => ({
            returning: async () => [{ ...current, ...values }],
          }),
        };
      },
    }),
  } as unknown as Database;
  return { db, getSet: () => capturedSet };
}

describe("transitionOrderStatus", () => {
  it("applies a valid transition and stamps the matching timestamp column", async () => {
    const current = baseOrder({ status: "ORDER_RECEIVED" });
    const { db, getSet } = fakeOrderDb(current);

    const updated = await transitionOrderStatus(db, "order-1", "PAID");

    expect(updated.status).toBe("PAID");
    expect(getSet()?.paidAt).toBeInstanceOf(Date);
  });

  it("rejects an illegal jump", async () => {
    const current = baseOrder({ status: "ORDER_RECEIVED" });
    const { db } = fakeOrderDb(current);

    await expect(transitionOrderStatus(db, "order-1", "SHIPPED")).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("merges extra financial fields supplied at transition time", async () => {
    const current = baseOrder({ status: "RETURN_REQUESTED" });
    const { db, getSet } = fakeOrderDb(current);

    const updated = await transitionOrderStatus(db, "order-1", "RETURNED", { extra: { returnAmountUsdCents: 5000 } });

    expect(updated.status).toBe("RETURNED");
    expect(getSet()?.returnAmountUsdCents).toBe(5000);
    expect(getSet()?.returnedAt).toBeInstanceOf(Date);
  });
});

describe("getLiveOrderProfit / finalizeOrderProfit", () => {
  it("computes live profit from the order's own fields", () => {
    const order = baseOrder({ salePriceUsdCents: 5000, ebayFeeUsdCents: 750 });
    const result = getLiveOrderProfit(order, 0.0067);
    expect(result.revenueUsdCents).toBe(5000);
    expect(result.netProfitUsdCents).toBe(5000 - 750);
  });

  it("snapshots the finalized profit and is safe to call twice with the same result", async () => {
    const order = baseOrder({ salePriceUsdCents: 5000, ebayFeeUsdCents: 750 });
    const { db, getSet } = fakeOrderDb(order);

    const finalized = await finalizeOrderProfit(db, "order-1", 0.0067);
    expect(finalized.finalizedNetProfitUsdCents).toBe(5000 - 750);
    expect(getSet()?.profitFinalizedAt).toBeInstanceOf(Date);

    // Re-finalizing from the same underlying row must reproduce the same number, not add to it.
    const { db: db2 } = fakeOrderDb(order);
    const finalizedAgain = await finalizeOrderProfit(db2, "order-1", 0.0067);
    expect(finalizedAgain.finalizedNetProfitUsdCents).toBe(finalized.finalizedNetProfitUsdCents);
  });
});

describe("list helpers", () => {
  it("listOrdersForProduct filters to the given product", async () => {
    const rows = [baseOrder({ id: "o1" })];
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }) } as unknown as Database;
    const result = await listOrdersForProduct(db, "product-1");
    expect(result).toEqual(rows);
  });

  it("listOrders applies a status filter when given one", async () => {
    const rows = [baseOrder({ status: "SHIPPED" })];
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
      }),
    } as unknown as Database;
    const result = await listOrders(db, { status: "SHIPPED" });
    expect(result).toEqual(rows);
  });

  it("listReservedOrdersForProduct only matches non-terminal, non-shipped statuses", async () => {
    const rows = [baseOrder({ status: "PAID" })];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Database;
    const result = await listReservedOrdersForProduct(db, "product-1");
    expect(result).toEqual(rows);
  });
});
