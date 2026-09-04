import type { ChannelAdapter, SaleEvent } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applySaleMock = vi.fn();

vi.mock("@ai-ec/db", () => ({
  applySale: (...args: unknown[]) => applySaleMock(...args),
  channelListings: {},
  productMaster: {},
}));

const getValidAccessTokenMock = vi.fn().mockResolvedValue("token-123");
const listConnectedAccountIdsMock = vi.fn().mockResolvedValue(["acct-1"]);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: vi.fn(),
  getDb: vi.fn(),
  getIdempotencyStore: vi.fn(),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: vi.fn(),
}));

const { processSale } = await import("./handler.js");

function createFakeDb(otherListing: unknown) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (otherListing ? [otherListing] : []),
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
    recordAuditLogMock.mockClear();
  });

  it("does nothing when the product is still in stock", async () => {
    applySaleMock.mockResolvedValue({ quantity: 4, soldOut: false, alreadyZero: false });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb(undefined), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
    expect(applySaleMock).toHaveBeenCalledWith(expect.anything(), "product-1", 1, {
      channel: "base",
      sequenceAt: sale.occurredAt,
      externalEventId: "order-1",
    });
  });

  it("does not re-zero the other channel when this sale lost the race (already sold out)", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: true });
    const setInventory = vi.fn();
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(createFakeDb({ status: "published", externalId: "ebay-sku-1" }), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
  });

  it("zeroes out the other channel's published listing exactly once when a sale drives stock to zero", async () => {
    applySaleMock.mockResolvedValue({ quantity: 0, soldOut: true, alreadyZero: false });
    const setInventory = vi.fn().mockResolvedValue(undefined);
    const adapters = { base: {}, ebay: { setInventory } } as unknown as Record<string, ChannelAdapter>;

    await processSale(
      createFakeDb({ status: "published", externalId: "ebay-sku-1" }),
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

    await processSale(createFakeDb(undefined), adapters as never, "product-1", sale);

    expect(setInventory).not.toHaveBeenCalled();
  });
});
