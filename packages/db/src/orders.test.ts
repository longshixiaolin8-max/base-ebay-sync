import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  DdpConfirmationRequiredError,
  finalizeOrderProfit,
  getLiveOrderProfit,
  getTenantMarginHistory,
  InvalidOrderTransitionError,
  listOrders,
  listOrdersForProduct,
  listReservedOrdersForProduct,
  OrderStatusConflictError,
  transitionOrderStatus,
  upsertOrderReceived,
  type OrderRow,
} from "./orders.js";

function baseOrder(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: "order-1",
    tenantId: "tenant-a",
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
      tenantId: "tenant-a",
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
      tenantId: "tenant-a",
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

    const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "PAID");

    expect(updated.status).toBe("PAID");
    expect(getSet()?.paidAt).toBeInstanceOf(Date);
  });

  it("rejects an illegal jump", async () => {
    const current = baseOrder({ status: "ORDER_RECEIVED" });
    const { db } = fakeOrderDb(current);

    await expect(transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED")).rejects.toThrow(InvalidOrderTransitionError);
  });

  it("merges extra financial fields supplied at transition time", async () => {
    const current = baseOrder({ status: "RETURN_REQUESTED" });
    const { db, getSet } = fakeOrderDb(current);

    const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "RETURNED", { extra: { returnAmountUsdCents: 5000 } });

    expect(updated.status).toBe("RETURNED");
    expect(getSet()?.returnAmountUsdCents).toBe(5000);
    expect(getSet()?.returnedAt).toBeInstanceOf(Date);
  });

  it("never lets a stray status key inside extra override the validated toStatus", async () => {
    const current = baseOrder({ status: "ALLOCATED" });
    const { db, getSet } = fakeOrderDb(current);

    const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED", {
      extra: { returnAmountUsdCents: 5000, status: "REFUNDED" } as unknown as Record<string, number>,
    });

    expect(updated.status).toBe("SHIPPED");
    expect(getSet()?.status).toBe("SHIPPED");
  });

  it("throws OrderStatusConflictError instead of overwriting when the order moved off fromStatus concurrently", async () => {
    // Simulates another request having already won the race: the UPDATE's WHERE (which
    // includes status = fromStatus) matches zero rows, so .returning() comes back empty.
    const current = baseOrder({ status: "PAID" });
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    } as unknown as Database;

    await expect(transitionOrderStatus(db, "tenant-a", "order-1", "ALLOCATED")).rejects.toThrow(OrderStatusConflictError);
  });

  it("invalidates an already-finalized profit snapshot when a profit-affecting extra field is written", async () => {
    const current = baseOrder({
      status: "RETURN_REQUESTED",
      profitFinalizedAt: new Date("2026-01-05T00:00:00Z"),
      finalizedNetProfitUsdCents: 1234,
    });
    const { db, getSet } = fakeOrderDb(current);

    await transitionOrderStatus(db, "tenant-a", "order-1", "RETURNED", { extra: { returnAmountUsdCents: 2000 } });

    // Otherwise every dashboard/analytics reader that trusts profitFinalizedAt as ground truth
    // would keep serving the pre-return profit number forever, since nothing else re-finalizes.
    expect(getSet()?.profitFinalizedAt).toBeNull();
    expect(getSet()?.finalizedNetProfitUsdCents).toBeNull();
  });

  it("leaves an already-finalized profit snapshot alone when the transition carries no profit-affecting field", async () => {
    const current = baseOrder({
      status: "DELIVERED",
      profitFinalizedAt: new Date("2026-01-05T00:00:00Z"),
      finalizedNetProfitUsdCents: 1234,
    });
    const { db, getSet } = fakeOrderDb(current);

    await transitionOrderStatus(db, "tenant-a", "order-1", "RETURN_REQUESTED");

    expect(getSet()?.profitFinalizedAt).toBeUndefined();
    expect(getSet()?.finalizedNetProfitUsdCents).toBeUndefined();
  });

  describe("DDP compliance gate on SHIPPED", () => {
    function ddpRequiredOrder(overrides: Partial<OrderRow> = {}): OrderRow {
      return baseOrder({
        status: "ALLOCATED",
        channel: "ebay",
        shipToCountryCode: "US",
        salePriceUsdCents: 15_000,
        placedAt: new Date("2026-01-01T00:00:00Z"),
        ddpConfirmedAt: null,
        ...overrides,
      });
    }

    it("rejects marking a DDP-required order SHIPPED without ddpConfirmed", async () => {
      const { db } = fakeOrderDb(ddpRequiredOrder());

      await expect(transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED")).rejects.toThrow(DdpConfirmationRequiredError);
    });

    it("allows marking it SHIPPED once ddpConfirmed is passed, and stamps ddpConfirmedAt", async () => {
      const { db, getSet } = fakeOrderDb(ddpRequiredOrder());

      const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED", { ddpConfirmed: true });

      expect(updated.status).toBe("SHIPPED");
      expect(getSet()?.ddpConfirmedAt).toBeInstanceOf(Date);
    });

    it("does not re-require confirmation for an order already confirmed", async () => {
      const current = ddpRequiredOrder({ status: "ALLOCATED", ddpConfirmedAt: new Date("2026-01-02T00:00:00Z") });
      const { db, getSet } = fakeOrderDb(current);

      const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED");

      expect(updated.status).toBe("SHIPPED");
      // Already confirmed earlier -- this transition shouldn't need to re-stamp it.
      expect(getSet()?.ddpConfirmedAt).toBeUndefined();
    });

    it("does not gate a BASE order even if it ships to the US", async () => {
      const current = ddpRequiredOrder({ channel: "base", status: "ALLOCATED" });
      const { db } = fakeOrderDb(current);

      const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED");
      expect(updated.status).toBe("SHIPPED");
    });

    it("does not gate an eBay order shipping to a non-US destination", async () => {
      const current = ddpRequiredOrder({ shipToCountryCode: "GB" });
      const { db } = fakeOrderDb(current);

      const updated = await transitionOrderStatus(db, "tenant-a", "order-1", "SHIPPED");
      expect(updated.status).toBe("SHIPPED");
    });
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

    const finalized = await finalizeOrderProfit(db, "tenant-a", "order-1", 0.0067);
    expect(finalized.finalizedNetProfitUsdCents).toBe(5000 - 750);
    expect(getSet()?.profitFinalizedAt).toBeInstanceOf(Date);

    // Re-finalizing from the same underlying row must reproduce the same number, not add to it.
    const { db: db2 } = fakeOrderDb(order);
    const finalizedAgain = await finalizeOrderProfit(db2, "tenant-a", "order-1", 0.0067);
    expect(finalizedAgain.finalizedNetProfitUsdCents).toBe(finalized.finalizedNetProfitUsdCents);
  });
});

describe("list helpers", () => {
  it("listOrdersForProduct filters to the given product", async () => {
    const rows = [baseOrder({ id: "o1" })];
    const db = { select: () => ({ from: () => ({ where: () => ({ orderBy: async () => rows }) }) }) } as unknown as Database;
    const result = await listOrdersForProduct(db, "tenant-a", "product-1");
    expect(result).toEqual(rows);
  });

  it("listOrders applies a status filter when given one", async () => {
    const rows = [baseOrder({ status: "SHIPPED" })];
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
      }),
    } as unknown as Database;
    const result = await listOrders(db, "tenant-a", { status: "SHIPPED" });
    expect(result).toEqual(rows);
  });

  it("listReservedOrdersForProduct only matches non-terminal, non-shipped statuses", async () => {
    const rows = [baseOrder({ status: "PAID" })];
    const db = { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Database;
    const result = await listReservedOrdersForProduct(db, "tenant-a", "product-1");
    expect(result).toEqual(rows);
  });
});

describe("getTenantMarginHistory", () => {
  function dbWithRows(rows: Array<{ netProfit: number | null; revenue: number | null }>) {
    return {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }),
      }),
    } as unknown as Database;
  }

  it("returns null/0 when there's no finalized eBay order history yet", async () => {
    const result = await getTenantMarginHistory(dbWithRows([]), "tenant-a");
    expect(result).toEqual({ avgMarkupRatio: null, sampleSize: 0 });
  });

  it("reconstructs each order's cost as revenue - netProfit and averages netProfit/cost (a markup ratio, not netProfit/revenue)", async () => {
    // Row 1: cost = 10000-2000 = 8000, markup = 2000/8000 = 0.25
    // Row 2: cost = 9000-3000 = 6000, markup = 3000/6000 = 0.5
    // Average markup = 0.375 -- notably NOT 0.277..., which is what netProfit/revenue would
    // have given (the exact unit mismatch this function used to have).
    const result = await getTenantMarginHistory(
      dbWithRows([
        { netProfit: 2000, revenue: 10000 },
        { netProfit: 3000, revenue: 9000 },
      ]),
      "tenant-a",
    );
    expect(result.sampleSize).toBe(2);
    expect(result.avgMarkupRatio).toBeCloseTo(0.375, 5);
  });

  it("skips rows with no usable revenue/profit data, or whose reconstructed cost is zero or negative", async () => {
    const result = await getTenantMarginHistory(
      dbWithRows([
        { netProfit: 2000, revenue: 10000 }, // cost 8000, markup 0.25 -- the only valid row
        { netProfit: null, revenue: 10000 },
        { netProfit: 500, revenue: null },
        { netProfit: 500, revenue: 400 }, // cost = 400-500 = -100, an impossible/corrupt row
      ]),
      "tenant-a",
    );
    expect(result.sampleSize).toBe(1);
    expect(result.avgMarkupRatio).toBeCloseTo(0.25, 5);
  });
});
