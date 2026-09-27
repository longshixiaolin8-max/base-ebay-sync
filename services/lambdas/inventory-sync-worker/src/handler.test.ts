import type { ChannelAdapter, IdempotencyStore, SaleEvent } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applySaleWithOutboxMock = vi.fn();
const isChannelIsolatedMock = vi.fn().mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
const upsertOrderReceivedMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@ai-ec/db", () => ({
  applySaleWithOutbox: (...args: unknown[]) => applySaleWithOutboxMock(...args),
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
  channelListings: {},
  inventoryMaster: {},
  productMaster: {},
  syncJobs: {},
  isChannelIsolated: (...args: unknown[]) => isChannelIsolatedMock(...args),
  upsertOrderReceived: (...args: unknown[]) => upsertOrderReceivedMock(...args),
}));

const getValidAccessTokenMock = vi.fn().mockResolvedValue("token-123");
const listConnectedAccountIdsMock = vi.fn().mockResolvedValue(["acct-1"]);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
const getIdempotencyStoreMock = vi.fn();
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "secret" });
const getDbMock = vi.fn();
const createEbayAdapterMock = vi.fn();

vi.mock("@ai-ec/lambda-shared", () => ({
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: (...args: unknown[]) => getDbMock(...args),
  getIdempotencyStore: (...args: unknown[]) => getIdempotencyStoreMock(...args),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

vi.mock("@ai-ec/adapter-base", () => ({ BaseAdapter: vi.fn().mockImplementation(() => ({})) }));

const { runPhaseA, dispatchPhaseB, handler } = await import("./handler.js");

const TENANT_ID = "tenant-a";

/** Each entry is the array `select().from().where().limit()` resolves to for one call,
 *  consumed in call order — mirrors the real query sequence in runPhaseA/dispatchPhaseB. */
function createFakeDb(selectResults: unknown[][]) {
  let i = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults[i++] ?? [],
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  } as never;
}

const sale: SaleEvent = {
  channel: "base",
  externalProductId: "base-item-1",
  externalOrderId: "order-1",
  quantitySold: 1,
  occurredAt: new Date("2026-08-28T00:00:00Z"),
};

describe("runPhaseA", () => {
  beforeEach(() => {
    applySaleWithOutboxMock.mockReset();
    upsertOrderReceivedMock.mockClear();
    upsertOrderReceivedMock.mockResolvedValue(undefined);
    recordSyncErrorMock.mockClear();
  });

  it("calls applySaleWithOutbox with the sale's own channel as the `channel` and the other channel", async () => {
    applySaleWithOutboxMock.mockResolvedValue({ sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" });

    await runPhaseA(createFakeDb([[]]), TENANT_ID, "product-1", sale);

    expect(applySaleWithOutboxMock).toHaveBeenCalledWith(expect.anything(), TENANT_ID, "product-1", 1, {
      channel: "base",
      sequenceAt: sale.occurredAt,
      externalEventId: "order-1",
      otherChannel: "ebay",
    });
  });

  it("records an order for a genuine (non-duplicate) sale, snapshotting the product's cost", async () => {
    applySaleWithOutboxMock.mockResolvedValue({ sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" });

    await runPhaseA(createFakeDb([[{ costJpy: 3000 }]]), TENANT_ID, "product-1", sale);

    expect(upsertOrderReceivedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ productId: "product-1", channel: "base", externalOrderId: "order-1", quantity: 1, costJpy: 3000 }),
    );
  });

  it("never lets an order-bookkeeping failure block or fail the sale processing", async () => {
    applySaleWithOutboxMock.mockResolvedValue({ sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" });
    upsertOrderReceivedMock.mockRejectedValue(new Error("boom"));

    const result = await runPhaseA(createFakeDb([[]]), TENANT_ID, "product-1", sale);

    expect(result.outboxJobId).toBe("job-1");
    expect(recordSyncErrorMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ errorCode: "order_record_failed" }));
  });

  it("still records the order when this sale lost the double-sell race", async () => {
    applySaleWithOutboxMock.mockResolvedValue({ sale: { quantity: 0, soldOut: true, alreadyZero: true }, outboxJobId: null });

    await runPhaseA(createFakeDb([[{ costJpy: 3000 }]]), TENANT_ID, "product-1", sale);

    expect(upsertOrderReceivedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ productId: "product-1", channel: "base", externalOrderId: "order-1" }),
    );
  });
});

describe("dispatchPhaseB", () => {
  beforeEach(() => {
    getValidAccessTokenMock.mockClear();
    listConnectedAccountIdsMock.mockClear();
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordAuditLogMock.mockClear();
    recordSyncErrorMock.mockClear();
    isChannelIsolatedMock.mockClear();
    isChannelIsolatedMock.mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
  });

  it("does nothing when there is no outbox job (no listing published on the other channel)", async () => {
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: null };

    await dispatchPhaseB(createFakeDb([]), TENANT_ID, adapters as never, "product-1", sale, phaseA);

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("records a possible-double-sale error and does not dispatch when the sale lost the race (alreadyZero)", async () => {
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 0, soldOut: true, alreadyZero: true }, outboxJobId: null };

    await dispatchPhaseB(createFakeDb([]), TENANT_ID, adapters as never, "product-1", sale, phaseA);

    expect(setInventory).not.toHaveBeenCalled();
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "possible_double_sale", payload: expect.objectContaining({ externalOrderId: "order-1" }) }),
    );
  });

  it("skips dispatch when the outbox job was already marked completed (concurrent/earlier attempt)", async () => {
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" };

    await dispatchPhaseB(
      createFakeDb([[{ id: "job-1", status: "completed", attempts: 0 }]]), // sync_jobs lookup
      TENANT_ID,
      adapters as never,
      "product-1",
      sale,
      phaseA,
    );

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("zeroes out the other channel's published listing exactly once when a sale drove stock to zero", async () => {
    const setInventory = vi.fn().mockResolvedValue(undefined);
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 0, soldOut: true, alreadyZero: false }, outboxJobId: "job-1" };

    await dispatchPhaseB(
      createFakeDb([
        [{ id: "job-1", status: "pending", attempts: 0 }], // sync_jobs lookup
        [{ status: "published", externalId: "ebay-sku-1" }], // otherListing
      ]),
      TENANT_ID,
      adapters as never,
      "product-1",
      sale,
      phaseA,
    );

    expect(setInventory).toHaveBeenCalledTimes(1);
    expect(setInventory).toHaveBeenCalledWith("token-123", "ebay-sku-1", 0);
    expect(recordAuditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "inventory_zeroed_due_to_sale" }));
  });

  it("pushes the freshly-reduced available quantity immediately on a partial decrement", async () => {
    const setInventory = vi.fn().mockResolvedValue(undefined);
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" };

    await dispatchPhaseB(
      createFakeDb([
        [{ id: "job-1", status: "pending", attempts: 0 }], // sync_jobs lookup
        [{ status: "published", externalId: "ebay-sku-1" }], // otherListing
        [{ sourceChannel: "base" }], // product_master
        [{ quantity: 4, safetyStockBuffer: 1 }], // inventory_master
      ]),
      TENANT_ID,
      adapters as never,
      "product-1",
      sale,
      phaseA,
    );

    expect(setInventory).toHaveBeenCalledTimes(1);
    expect(setInventory).toHaveBeenCalledWith("token-123", "ebay-sku-1", 3); // 4 true stock - 1 buffer
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "inventory_immediate_sync_after_sale", after: expect.objectContaining({ pushedQuantity: 3 }) }),
    );
  });

  it("does not push and does not throw when a partial decrement's other-channel account isn't connected", async () => {
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" };

    await expect(
      dispatchPhaseB(
        createFakeDb([[{ id: "job-1", status: "pending", attempts: 0 }], [{ status: "published", externalId: "ebay-sku-1" }]]),
        TENANT_ID,
        adapters as never,
        "product-1",
        sale,
        phaseA,
      ),
    ).resolves.toBeUndefined();

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("marks the outbox job failed and rethrows PhaseBDispatchError when sold-out and no account is connected", async () => {
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 0, soldOut: true, alreadyZero: false }, outboxJobId: "job-1" };

    await expect(
      dispatchPhaseB(
        createFakeDb([[{ id: "job-1", status: "pending", attempts: 0 }], [{ status: "published", externalId: "ebay-sku-1" }]]),
        TENANT_ID,
        adapters as never,
        "product-1",
        sale,
        phaseA,
      ),
    ).rejects.toThrow(/no ebay account is connected/);

    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "channel_inventory_push_failed", jobId: "job-1" }),
    );
  });

  it("marks the outbox job failed and rethrows when setInventory itself fails", async () => {
    const setInventory = vi.fn().mockRejectedValue(new Error("eBay API error 500: boom"));
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 4, soldOut: false, alreadyZero: false }, outboxJobId: "job-1" };

    await expect(
      dispatchPhaseB(
        createFakeDb([
          [{ id: "job-1", status: "pending", attempts: 2 }],
          [{ status: "published", externalId: "ebay-sku-1" }],
          [{ sourceChannel: "base" }],
          [{ quantity: 4, safetyStockBuffer: 1 }],
        ]),
        TENANT_ID,
        adapters as never,
        "product-1",
        sale,
        phaseA,
      ),
    ).rejects.toThrow(/boom/);

    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "channel_inventory_push_failed", jobId: "job-1" }),
    );
  });

  it("skips the other channel gracefully (no throw) when it is isolated, even on a sellout", async () => {
    isChannelIsolatedMock.mockResolvedValue({
      channel: "ebay",
      isolated: true,
      reasons: ["an authentication failure was recorded for ebay in the last 15min"],
      windowMinutes: 15,
    });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;
    const phaseA = { sale: { quantity: 0, soldOut: true, alreadyZero: false }, outboxJobId: "job-1" };

    await expect(
      dispatchPhaseB(
        createFakeDb([[{ id: "job-1", status: "pending", attempts: 0 }], [{ status: "published", externalId: "ebay-sku-1" }]]),
        TENANT_ID,
        adapters as never,
        "product-1",
        sale,
        phaseA,
      ),
    ).resolves.toBeUndefined();

    expect(setInventory).not.toHaveBeenCalled();
    expect(listConnectedAccountIdsMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "other_channel_isolated_skip" }));
  });
});

/** A real (in-memory) IdempotencyStore, not a stub -- this is what actually proves the fix:
 *  a "completed" key's cached result is replayed without calling `fn` again, and a "failed"
 *  key IS re-claimable, mirroring createDbIdempotencyStore's real semantics exactly. */
function createInMemoryIdempotencyStore(): IdempotencyStore {
  const rows = new Map<string, { status: "in_progress" | "completed" | "failed"; result: unknown }>();
  return {
    async tryClaim(key) {
      const existing = rows.get(key);
      if (existing && existing.status !== "failed") return { key, ...existing };
      rows.set(key, { status: "in_progress", result: null });
      return null;
    },
    async complete(key, result) {
      rows.set(key, { status: "completed", result });
    },
    async fail(key) {
      rows.set(key, { status: "failed", result: null });
    },
  };
}

describe("handler (end-to-end idempotency, using a real in-memory IdempotencyStore)", () => {
  function makeEvent(messageId = "msg-1") {
    return {
      Records: [{ messageId, body: JSON.stringify({ type: "sale_detected", tenantId: TENANT_ID, sale }) }],
    } as never;
  }

  /** Tracks a real, mutable central-stock counter: only decrements when actually invoked,
   *  so a test can assert the true post-condition (stock) rather than just call counts. */
  function createStockTracker(initialStock: number) {
    let stock = initialStock;
    return {
      get stock() {
        return stock;
      },
      apply: vi.fn(async (_db: unknown, _tenantId: string, _productId: string, quantitySold: number) => {
        if (stock <= 0) return { sale: { quantity: 0, soldOut: true, alreadyZero: true }, outboxJobId: null };
        stock = Math.max(0, stock - quantitySold);
        return { sale: { quantity: stock, soldOut: stock === 0, alreadyZero: false }, outboxJobId: "job-1" };
      }),
    };
  }

  beforeEach(() => {
    recordSyncErrorMock.mockClear();
    upsertOrderReceivedMock.mockClear().mockResolvedValue(undefined);
    listConnectedAccountIdsMock.mockClear().mockResolvedValue(["acct-1"]);
    isChannelIsolatedMock.mockClear().mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
    createEbayAdapterMock.mockReset();
    getDbMock.mockReset();
    applySaleWithOutboxMock.mockReset();
  });

  it("never decrements central stock more than once for the same sale, even across repeated SQS redeliveries where the external push keeps failing", async () => {
    const tracker = createStockTracker(5);
    applySaleWithOutboxMock.mockImplementation(tracker.apply);
    const store = createInMemoryIdempotencyStore();
    getIdempotencyStoreMock.mockReturnValue(store);

    const setInventory = vi.fn().mockRejectedValue(new Error("eBay API error 503: temporarily unavailable"));
    createEbayAdapterMock.mockReturnValue({ setInventory });
    getDbMock.mockReturnValue(
      createFakeDb([
        // First delivery: listing lookup, then runPhaseA's productForOrder select, then
        // dispatchPhaseB's sync_jobs + otherListing + product_master + inventory_master.
        [{ productId: "product-1" }],
        [{ costJpy: null }],
        [{ id: "job-1", status: "pending", attempts: 0 }],
        [{ status: "published", externalId: "ebay-sku-1" }],
        [{ sourceChannel: "base" }],
        [{ quantity: 4, safetyStockBuffer: 0 }],
      ]),
    );

    const result1 = await handler(makeEvent(), {} as never, {} as never);
    expect((result1 as { batchItemFailures: unknown[] }).batchItemFailures).toHaveLength(1);
    expect(tracker.stock).toBe(4);
    expect(applySaleWithOutboxMock).toHaveBeenCalledTimes(1);

    // Simulate 5 more SQS redeliveries of the exact same message. Each one re-reads the DB
    // for its own dispatchPhaseB attempt (fresh fake db per call, same running total),
    // while sharing the same idempotency store instance across all six calls.
    for (let attempt = 0; attempt < 5; attempt++) {
      getDbMock.mockReturnValue(
        createFakeDb([
          [{ productId: "product-1" }],
          [{ id: "job-1", status: "pending", attempts: attempt }],
          [{ status: "published", externalId: "ebay-sku-1" }],
          [{ sourceChannel: "base" }],
          [{ quantity: tracker.stock, safetyStockBuffer: 0 }],
        ]),
      );
      await handler(makeEvent(), {} as never, {} as never);
    }

    // The core assertion: 6 total handler() invocations for the same real-world sale, and
    // central stock decremented exactly once.
    expect(applySaleWithOutboxMock).toHaveBeenCalledTimes(1);
    expect(tracker.stock).toBe(4);
  });

  it("holds stock at 0 (never negative) across repeated redeliveries of a sellout sale whose external push keeps failing", async () => {
    const tracker = createStockTracker(1);
    applySaleWithOutboxMock.mockImplementation(tracker.apply);
    const store = createInMemoryIdempotencyStore();
    getIdempotencyStoreMock.mockReturnValue(store);

    const setInventory = vi.fn().mockRejectedValue(new Error("eBay API error 503: temporarily unavailable"));
    createEbayAdapterMock.mockReturnValue({ setInventory });

    for (let attempt = 0; attempt < 6; attempt++) {
      getDbMock.mockReturnValue(
        createFakeDb([
          [{ productId: "product-1" }],
          [{ costJpy: null }],
          [{ id: "job-1", status: "pending", attempts: attempt }],
          [{ status: "published", externalId: "ebay-sku-1" }],
        ]),
      );
      await handler(makeEvent(), {} as never, {} as never);
    }

    expect(applySaleWithOutboxMock).toHaveBeenCalledTimes(1);
    expect(tracker.stock).toBe(0);
  });

  it("applies a genuinely different order's sale normally, decrementing again", async () => {
    const tracker = createStockTracker(5);
    applySaleWithOutboxMock.mockImplementation(tracker.apply);
    const store = createInMemoryIdempotencyStore();
    getIdempotencyStoreMock.mockReturnValue(store);
    const setInventory = vi.fn().mockResolvedValue(undefined);
    createEbayAdapterMock.mockReturnValue({ setInventory });

    getDbMock.mockReturnValue(
      createFakeDb([
        [{ productId: "product-1" }],
        [{ costJpy: null }],
        [{ id: "job-1", status: "pending", attempts: 0 }],
        [{ status: "published", externalId: "ebay-sku-1" }],
        [{ sourceChannel: "base" }],
        [{ quantity: 4, safetyStockBuffer: 0 }],
      ]),
    );
    await handler(makeEvent("msg-1"), {} as never, {} as never);
    expect(tracker.stock).toBe(4);

    const secondSale: SaleEvent = { ...sale, externalOrderId: "order-2" };
    getDbMock.mockReturnValue(
      createFakeDb([
        [{ productId: "product-1" }],
        [{ costJpy: null }],
        [{ id: "job-2", status: "pending", attempts: 0 }],
        [{ status: "published", externalId: "ebay-sku-1" }],
        [{ sourceChannel: "base" }],
        [{ quantity: 3, safetyStockBuffer: 0 }],
      ]),
    );
    await handler(
      { Records: [{ messageId: "msg-2", body: JSON.stringify({ type: "sale_detected", tenantId: TENANT_ID, sale: secondSale }) }] } as never,
      {} as never,
      {} as never,
    );

    expect(applySaleWithOutboxMock).toHaveBeenCalledTimes(2);
    expect(tracker.stock).toBe(3);
  });
});
