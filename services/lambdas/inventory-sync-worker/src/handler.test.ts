import type { ChannelAdapter, SaleEvent } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applySaleMock = vi.fn();
const isChannelIsolatedMock = vi.fn().mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
const upsertOrderReceivedMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@ai-ec/db", () => ({
  applySale: (...args: unknown[]) => applySaleMock(...args),
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
  channelListings: {},
  inventoryMaster: {},
  productMaster: {},
  isChannelIsolated: (...args: unknown[]) => isChannelIsolatedMock(...args),
  upsertOrderReceived: (...args: unknown[]) => upsertOrderReceivedMock(...args),
}));

const getValidAccessTokenMock = vi.fn().mockResolvedValue("token-123");
const listConnectedAccountIdsMock = vi.fn().mockResolvedValue(["acct-1"]);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: vi.fn(),
  getDb: vi.fn(),
  getIdempotencyStore: vi.fn(),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const { processSale } = await import("./handler.js");

/** Each entry is the array `select().from().where().limit()` resolves to for one call,
 *  consumed in call order — mirrors the real query sequence in processSale(). */
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

describe("processSale", () => {
  beforeEach(() => {
    applySaleMock.mockReset();
    getValidAccessTokenMock.mockClear();
    listConnectedAccountIdsMock.mockClear();
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordAuditLogMock.mockClear();
    recordSyncErrorMock.mockClear();
    isChannelIsolatedMock.mockClear();
    isChannelIsolatedMock.mockResolvedValue({ channel: "ebay", isolated: false, reasons: [], windowMinutes: 15 });
    upsertOrderReceivedMock.mockClear();
    upsertOrderReceivedMock.mockResolvedValue(undefined);
  });

  it("does nothing when the product is still in stock and no listing is published on the other channel", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb([[], []]), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
    expect(applySaleMock).toHaveBeenCalledWith(expect.anything(), "product-1", 1, {
      channel: "base",
      sequenceAt: sale.occurredAt,
      externalEventId: "order-1",
    });
  });

  it("records an order for a genuine (non-duplicate) sale, snapshotting the product's cost", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const adapters = { base: {}, ebay: { setInventory: vi.fn() } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb([[{ costJpy: 3000 }], []]), adapters as never, "product-1", sale);

    expect(upsertOrderReceivedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        productId: "product-1",
        channel: "base",
        externalOrderId: "order-1",
        quantity: 1,
        costJpy: 3000,
      }),
    );
  });

  it("passes the sale event's own price through to the order record when the adapter captured one", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const adapters = { base: {}, ebay: { setInventory: vi.fn() } } as unknown as Record<string, ChannelAdapter>;
    const pricedSale: SaleEvent = { ...sale, salePriceJpy: 4000 };

    await processSale(createFakeDb([[{ costJpy: null }], []]), adapters as never, "product-1", pricedSale);

    expect(upsertOrderReceivedMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ salePriceJpy: 4000, salePriceUsdCents: null }),
    );
  });

  it("never lets an order-bookkeeping failure block or fail the sale processing", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    upsertOrderReceivedMock.mockRejectedValue(new Error("boom"));
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await expect(processSale(createFakeDb([[], []]), adapters as never, "product-1", sale)).resolves.toBeUndefined();

    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ errorCode: "order_record_failed" }),
    );
  });

  it("does not re-zero the other channel when this sale lost the race (already sold out)", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: true });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb([]), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("zeroes out the other channel's published listing exactly once when a sale drives stock to zero", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: false });
    const setInventory = vi.fn().mockResolvedValue(undefined);
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(
      createFakeDb([[], [{ status: "published", externalId: "ebay-sku-1" }]]),
      adapters as never,
      "product-1",
      sale,
    );

    expect(setInventory).toHaveBeenCalledTimes(1);
    expect(setInventory).toHaveBeenCalledWith("token-123", "ebay-sku-1", 0);
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "inventory_zeroed_due_to_sale" }),
    );
  });

  it("skips the other-channel call when no listing is published there", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: false });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb([[], []]), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("pushes the freshly-reduced available quantity to the other channel immediately, rather than waiting for its next sync cycle", async () => {
    // Item #3 of the second hardening round ("即時同期"). A partial decrement (still in
    // stock) used to just return here and let the other channel's own scheduled/triggered
    // sync eventually notice — now it pushes right away.
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const setInventory = vi.fn().mockResolvedValue(undefined);
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(
      createFakeDb([
        [], // productForOrder (product_master, for order bookkeeping)
        [{ status: "published", externalId: "ebay-sku-1" }], // otherListing (channel_listings)
        [{ sourceChannel: "base" }], // product_master
        [{ quantity: 4, safetyStockBuffer: 1 }], // inventory_master
      ]),
      adapters as never,
      "product-1",
      sale,
    );

    expect(setInventory).toHaveBeenCalledTimes(1);
    expect(setInventory).toHaveBeenCalledWith("token-123", "ebay-sku-1", 3); // 4 true stock - 1 buffer
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "inventory_immediate_sync_after_sale", after: expect.objectContaining({ pushedQuantity: 3 }) }),
    );
  });

  it("does not push or fail the sale when a partial decrement's other-channel account isn't connected", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await expect(
      processSale(createFakeDb([[], [{ status: "published", externalId: "ebay-sku-1" }]]), adapters as never, "product-1", sale),
    ).resolves.toBeUndefined();

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("still throws when sold-out and the other channel's account isn't connected (nothing to zero it out with)", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: false });
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await expect(
      processSale(createFakeDb([[], [{ status: "published", externalId: "ebay-sku-1" }]]), adapters as never, "product-1", sale),
    ).rejects.toThrow(/no ebay account is connected/);
  });

  it("skips the other channel gracefully (no throw) when it is isolated, even on a sellout", async () => {
    // Item A of the third hardening round ("チャネル障害時の隔離モード"). Confirmed live:
    // eBay's oauth_connections row can exist (an account IS connected) while its access
    // token is expired with no refresh token -- a plain "account connected?" check can't
    // catch that, so this must be checked before ever reaching listConnectedAccountIds.
    isChannelIsolatedMock.mockResolvedValue({
      channel: "ebay",
      isolated: true,
      reasons: ["an authentication failure was recorded for ebay in the last 15min"],
      windowMinutes: 15,
    });
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: false });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await expect(
      processSale(createFakeDb([[], [{ status: "published", externalId: "ebay-sku-1" }]]), adapters as never, "product-1", sale),
    ).resolves.toBeUndefined();

    expect(setInventory).not.toHaveBeenCalled();
    expect(listConnectedAccountIdsMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "other_channel_isolated_skip" }),
    );
  });

  it("skips the other channel gracefully when it is isolated on a partial decrement too", async () => {
    isChannelIsolatedMock.mockResolvedValue({
      channel: "ebay",
      isolated: true,
      reasons: ["a 429 (rate limited) response was recorded for ebay's own API in the last 15min"],
      windowMinutes: 15,
    });
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(
      createFakeDb([[], [{ status: "published", externalId: "ebay-sku-1" }]]),
      adapters as never,
      "product-1",
      sale,
    );

    expect(setInventory).not.toHaveBeenCalled();
  });
});
