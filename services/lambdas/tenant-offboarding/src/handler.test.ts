import type { ChannelAdapter, ChannelType } from "@ai-ec/core";
import { describe, expect, it, vi } from "vitest";

const markTenantMarketplaceOffboardedMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/db", () => ({
  channelListings: { __table: "channelListings", tenantId: "tenantId", status: "status", id: "id" },
  listOffboardingCandidates: vi.fn(),
  markTenantMarketplaceOffboarded: (...args: unknown[]) => markTenantMarketplaceOffboardedMock(...args),
}));

const listConnectedAccountIdsMock = vi.fn();
const getValidAccessTokenMock = vi.fn();
const deleteOAuthConnectionsForTenantMock = vi.fn().mockResolvedValue([]);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  createEbayAdapter: vi.fn(),
  deleteOAuthConnectionsForTenant: (...args: unknown[]) => deleteOAuthConnectionsForTenantMock(...args),
  getAppCredentials: vi.fn(),
  getDb: vi.fn(),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const { offboardTenant } = await import("./handler.js");

const TENANT_ID = "tenant-a";

interface FakeListingRow {
  id: string;
  tenantId: string;
  productId: string;
  channel: string;
  externalId: string | null;
  status: string;
}

function createFakeDb(listings: FakeListingRow[]) {
  const updateCalls: Array<{ id: string; values: Record<string, unknown> }> = [];
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => listings.filter((l) => l.tenantId === TENANT_ID && l.status === "published"),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            // The real code always targets exactly the listing just processed via
            // eq(channelListings.id, listing.id); this fake's update() calls happen strictly
            // sequentially (one per listing, inside the same for-loop), so tracking "the
            // listing currently being updated" via closure over `listings` by id lookup
            // from `values` isn't available -- instead the test asserts on `updateCalls`
            // and cross-references listing state via the `listings` array mutated in place.
            updateCalls.push({ id: "unknown", values });
          },
        }),
      }),
    } as never,
    updateCalls,
  };
}

function fakeAdapter(delistImpl: (accessToken: string, externalId: string) => Promise<void>): ChannelAdapter {
  return { delistProduct: vi.fn(delistImpl) } as unknown as ChannelAdapter;
}

describe("offboardTenant", () => {
  it("offboarding前にmarketplace商品が放置されない: a tenant with no published listings is immediately confirmed offboarded", async () => {
    const { db } = createFakeDb([]);
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    markTenantMarketplaceOffboardedMock.mockClear();
    deleteOAuthConnectionsForTenantMock.mockClear();

    await offboardTenant(db, {}, TENANT_ID);

    expect(markTenantMarketplaceOffboardedMock).toHaveBeenCalledWith(db, TENANT_ID);
    expect(deleteOAuthConnectionsForTenantMock).toHaveBeenCalledWith(db, TENANT_ID, "base");
    expect(deleteOAuthConnectionsForTenantMock).toHaveBeenCalledWith(db, TENANT_ID, "ebay");
  });

  it("delists a published eBay listing, marks it delisted, then revokes OAuth and confirms offboarded", async () => {
    const listings: FakeListingRow[] = [
      { id: "listing-1", tenantId: TENANT_ID, productId: "product-1", channel: "ebay", externalId: "ext-1", status: "published" },
    ];
    const { db } = createFakeDb(listings);
    const delistMock = vi.fn().mockResolvedValue(undefined);
    const adapter = fakeAdapter(delistMock);
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    markTenantMarketplaceOffboardedMock.mockClear();
    recordAuditLogMock.mockClear();

    await offboardTenant(db, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>, TENANT_ID);

    expect(delistMock).toHaveBeenCalledWith("token-abc", "ext-1");
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ action: "listing_delisted_offboarding", entityId: "product-1" }),
    );
    expect(markTenantMarketplaceOffboardedMock).toHaveBeenCalledWith(db, TENANT_ID);
    expect(recordAuditLogMock).toHaveBeenCalledWith(db, expect.objectContaining({ action: "tenant_marketplace_offboarded" }));
  });

  it("offboarding前にmarketplace商品が放置されない: a delist failure leaves the listing published (not abandoned) and never marks the tenant offboarded", async () => {
    const listings: FakeListingRow[] = [
      { id: "listing-1", tenantId: TENANT_ID, productId: "product-1", channel: "ebay", externalId: "ext-1", status: "published" },
    ];
    const { db, updateCalls } = createFakeDb(listings);
    const adapter = fakeAdapter(() => Promise.reject(new Error("eBay API unavailable")));
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    markTenantMarketplaceOffboardedMock.mockClear();
    deleteOAuthConnectionsForTenantMock.mockClear();
    recordSyncErrorMock.mockClear();

    await offboardTenant(db, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>, TENANT_ID);

    // The failed listing was never marked "delisted" -- nothing was left in a half-updated,
    // untracked state -- and offboarding did NOT proceed to revoke OAuth or confirm the
    // tenant offboarded while a listing might still be live.
    expect(updateCalls).toHaveLength(0);
    expect(markTenantMarketplaceOffboardedMock).not.toHaveBeenCalled();
    expect(deleteOAuthConnectionsForTenantMock).not.toHaveBeenCalled();
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ tenantId: TENANT_ID, channel: "ebay", errorCode: "offboarding_delist_failed" }),
    );
  });

  it("one listing fails while a sibling listing succeeds: the successful one is still marked delisted, but OAuth revoke/offboarded-confirmation waits for both", async () => {
    const listings: FakeListingRow[] = [
      { id: "listing-1", tenantId: TENANT_ID, productId: "product-1", channel: "ebay", externalId: "ext-1", status: "published" },
      { id: "listing-2", tenantId: TENANT_ID, productId: "product-2", channel: "ebay", externalId: "ext-2", status: "published" },
    ];
    const { db, updateCalls } = createFakeDb(listings);
    const delistMock = vi.fn(async (_token: string, externalId: string) => {
      if (externalId === "ext-2") throw new Error("still has an active bid");
    });
    const adapter = fakeAdapter(delistMock);
    listConnectedAccountIdsMock.mockResolvedValue(["acct-1"]);
    getValidAccessTokenMock.mockResolvedValue("token-abc");
    markTenantMarketplaceOffboardedMock.mockClear();
    deleteOAuthConnectionsForTenantMock.mockClear();

    await offboardTenant(db, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>, TENANT_ID);

    expect(updateCalls).toHaveLength(1); // only listing-1's success was committed
    expect(markTenantMarketplaceOffboardedMock).not.toHaveBeenCalled();
    expect(deleteOAuthConnectionsForTenantMock).not.toHaveBeenCalled();
  });

  it("a published listing with no remaining OAuth connection doesn't block offboarding from completing", async () => {
    const listings: FakeListingRow[] = [
      { id: "listing-1", tenantId: TENANT_ID, productId: "product-1", channel: "ebay", externalId: "ext-1", status: "published" },
    ];
    const { db } = createFakeDb(listings);
    const adapter = fakeAdapter(vi.fn());
    listConnectedAccountIdsMock.mockResolvedValue([]); // already disconnected
    markTenantMarketplaceOffboardedMock.mockClear();

    await offboardTenant(db, { ebay: adapter } as Partial<Record<ChannelType, ChannelAdapter>>, TENANT_ID);

    expect(markTenantMarketplaceOffboardedMock).toHaveBeenCalledWith(db, TENANT_ID);
  });
});
