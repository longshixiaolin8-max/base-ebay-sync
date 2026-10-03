import type { ChannelAdapter, ChannelType } from "@ai-ec/core";
import { channelListings, inventoryMaster, productMaster } from "@ai-ec/db";
import { describe, expect, it, vi } from "vitest";

const getValidAccessTokenMock = vi.fn();
const listConnectedAccountIdsMock = vi.fn();
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: vi.fn(),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  loadImplementedChannelAdapters: vi.fn().mockResolvedValue({ base: {}, ebay: {} }),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const { checkTenant } = await import("./handler.js");

interface ListingRow {
  channel: string;
  productId: string;
  externalId: string | null;
  status: string;
}

interface MasterRow {
  quantity: number;
  safetyStockBuffer: number;
}

interface ProductRow {
  sourceChannel: string;
}

/** A minimal fake db: the only table-shaped selects checkTenant issues are (1) the published
 *  channel_listings for a tenant, and, per listing, (2) its inventory_master row and (3) its
 *  product_master row -- each test drives exactly one listing, so the master/product rows are
 *  returned unconditionally rather than re-implementing drizzle's WHERE filtering. */
function fakeDb(listings: ListingRow[], master: MasterRow, product: ProductRow) {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table === channelListings) {
          return { where: async () => listings };
        }
        if (table === inventoryMaster) {
          return { where: () => ({ limit: async () => [master] }) };
        }
        if (table === productMaster) {
          return { where: () => ({ limit: async () => [product] }) };
        }
        throw new Error("unexpected table in fakeDb.select().from()");
      },
    }),
  } as never;
}

function fakeAdapter(liveQuantity: number | null): ChannelAdapter {
  return { getInventory: vi.fn().mockResolvedValue(liveQuantity) } as unknown as ChannelAdapter;
}

const TENANT_ID = "tenant-a";
const PRODUCT_ID = "product-1";

describe("checkTenant (safety-stock-aware drift detection)", () => {
  it("BASE source / BASE live -- source channel is unbuffered, exact match -> no drift", async () => {
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordSyncErrorMock.mockClear();

    const listing: ListingRow = { channel: "base", productId: PRODUCT_ID, externalId: "ext-1", status: "published" };
    const master: MasterRow = { quantity: 10, safetyStockBuffer: 0 };
    const product: ProductRow = { sourceChannel: "base" };
    const db = fakeDb([listing], master, product);
    const adapter = fakeAdapter(10);

    await checkTenant(db, TENANT_ID, { base: adapter } as Partial<Record<ChannelType, ChannelAdapter>>);

    expect(recordSyncErrorMock).not.toHaveBeenCalled();
  });

  it("secondary channel (eBay) live quantity matches central minus safety buffer -> no drift", async () => {
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordSyncErrorMock.mockClear();

    const listing: ListingRow = { channel: "ebay", productId: PRODUCT_ID, externalId: "ext-1", status: "published" };
    const master: MasterRow = { quantity: 10, safetyStockBuffer: 2 };
    const product: ProductRow = { sourceChannel: "base" };
    const db = fakeDb([listing], master, product);
    const adapter = fakeAdapter(8);

    await checkTenant(db, TENANT_ID, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>);

    expect(recordSyncErrorMock).not.toHaveBeenCalled();
  });

  it("secondary channel (eBay) live quantity does not match central minus safety buffer -> drift recorded", async () => {
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordSyncErrorMock.mockClear();

    const listing: ListingRow = { channel: "ebay", productId: PRODUCT_ID, externalId: "ext-1", status: "published" };
    const master: MasterRow = { quantity: 10, safetyStockBuffer: 2 };
    const product: ProductRow = { sourceChannel: "base" };
    const db = fakeDb([listing], master, product);
    const adapter = fakeAdapter(9);

    await checkTenant(db, TENANT_ID, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>);

    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        tenantId: TENANT_ID,
        channel: "ebay",
        productId: PRODUCT_ID,
        errorCode: "inventory_drift",
        payload: expect.objectContaining({
          liveQuantity: 9,
          expectedQuantity: 8,
          centralQuantity: 10,
          safetyStockBuffer: 2,
          sourceChannel: "base",
          channel: "ebay",
        }),
      }),
    );
  });

  it("safety buffer larger than central quantity clamps expected quantity to 0, not negative", async () => {
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    recordSyncErrorMock.mockClear();

    const listing: ListingRow = { channel: "ebay", productId: PRODUCT_ID, externalId: "ext-1", status: "published" };
    const master: MasterRow = { quantity: 5, safetyStockBuffer: 10 };
    const product: ProductRow = { sourceChannel: "base" };
    const db = fakeDb([listing], master, product);

    // Live quantity 0 matches the clamped (never negative) expected value -> no drift.
    const adapterAtFloor = fakeAdapter(0);
    await checkTenant(db, TENANT_ID, { ebay: adapterAtFloor } as Partial<Record<ChannelType, ChannelAdapter>>);
    expect(recordSyncErrorMock).not.toHaveBeenCalled();

    // A live quantity that would only have matched a negative (unclamped) expected value
    // is correctly flagged as drift against the clamped expected=0.
    recordSyncErrorMock.mockClear();
    const adapterOffFloor = fakeAdapter(1);
    await checkTenant(db, TENANT_ID, { ebay: adapterOffFloor } as Partial<Record<ChannelType, ChannelAdapter>>);
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        payload: expect.objectContaining({ liveQuantity: 1, expectedQuantity: 0, centralQuantity: 5, safetyStockBuffer: 10 }),
      }),
    );
  });
});
