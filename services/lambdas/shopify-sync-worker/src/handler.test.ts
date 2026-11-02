import { beforeEach, describe, expect, it, vi } from "vitest";

const isChannelIsolatedMock = vi.fn().mockResolvedValue({ channel: "shopify", isolated: false, reasons: [], windowMinutes: 15 });

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  aiListingDraft: {},
  channelListings: { productId: "productId", channel: "channel" },
  inventoryMaster: {},
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
  isChannelIsolated: (...args: unknown[]) => isChannelIsolatedMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const fetchFxRateMock = vi.fn().mockResolvedValue({ fxRateUsdPerJpy: 0.0067, source: "test", fetchedAt: new Date() });
const listConnectedAccountIdsMock = vi.fn().mockResolvedValue(["my-store"]);
const getValidAccessTokenMock = vi.fn().mockResolvedValue("token");
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
const createShopifyAdapterMock = vi.fn();
const enqueueMock = vi.fn().mockResolvedValue(undefined);
const getQueueUrlsMock = vi.fn().mockReturnValue({ aiGenerate: "ai-generate-url" });
vi.mock("@ai-ec/lambda-shared", () => ({
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  fetchFxRate: (...args: unknown[]) => fetchFxRateMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
  createShopifyAdapter: (...args: unknown[]) => createShopifyAdapterMock(...args),
  getAppCredentials: vi.fn().mockResolvedValue({ clientId: "cid", clientSecret: "secret" }),
  getDb: vi.fn(),
  getIdempotencyStore: () => ({ claim: vi.fn(), complete: vi.fn() }),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  getQueueUrls: (...args: unknown[]) => getQueueUrlsMock(...args),
}));

const { publish, update } = await import("./handler.js");

const TENANT_ID = "tenant-a";

/** A drizzle-style query chain that resolves to `result` no matter which methods are chained. */
function chain(result: unknown) {
  const self: Record<string, unknown> = {
    from: () => self,
    where: () => self,
    orderBy: () => self,
    limit: () => self,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return self;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double, deliberately untyped like the Database it stands in for
function createFakeDb(selectResults: unknown[]): any {
  let i = 0;
  const setMock = vi.fn(() => ({ where: async () => undefined }));
  return {
    select: () => chain(selectResults[i++]),
    update: vi.fn(() => ({ set: setMock })),
    setMock,
  };
}

const product = {
  id: "p1",
  sku: "base-1",
  sourceChannel: "base",
  priceJpy: 10000,
  contentHash: "hash-1",
  images: ["https://img.example/1.jpg"],
  shippingCostUsdCents: null,
  targetMarginBasisPoints: null,
};
const draft = {
  titleEn: "Item",
  descriptionHtmlEn: "<p>d</p>",
  suggestedPriceUsd: 5000, // $50.00
  categoryCandidates: [{ ebayCategoryId: "1", label: "Cat" }],
  itemSpecifics: {},
  condition: "USED_GOOD",
  sourceContentHash: "hash-1",
};

describe("publish", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
    isChannelIsolatedMock.mockClear().mockResolvedValue({ channel: "shopify", isolated: false, reasons: [], windowMinutes: 15 });
  });

  it("creates a Shopify listing from the same AI draft eBay uses, applying the safety-stock buffer against the available quantity", async () => {
    const createListingMock = vi.fn().mockResolvedValue({ externalId: "my-store::111" });
    const adapter = { createListing: createListingMock } as never;
    const inventory = { quantity: 10, safetyStockBuffer: 2, version: 1 };

    const db = createFakeDb([[product], [draft], [inventory]]);
    await publish(db, TENANT_ID, adapter, "token-1", "p1");

    expect(createListingMock).toHaveBeenCalledWith(
      "token-1",
      expect.objectContaining({
        productId: "p1",
        sku: "base-1",
        titleEn: "Item",
        descriptionHtmlEn: "<p>d</p>",
        priceUsd: 50,
        quantity: 8, // 10 - safetyStockBuffer(2), since shopify !== sourceChannel("base")
        images: ["https://img.example/1.jpg"],
      }),
    );
    expect(db.setMock).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "my-store::111", status: "published", lastSyncedPriceJpy: 10000 }),
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "shopify_listing_published", entityId: "p1" }),
    );
  });

  it("refuses to publish a stale draft (sourceContentHash no longer matches the product's current contentHash) and enqueues regeneration instead", async () => {
    enqueueMock.mockClear();
    const createListingMock = vi.fn();
    const adapter = { createListing: createListingMock } as never;
    const staleDraft = { ...draft, sourceContentHash: "hash-OLD" };
    const db = createFakeDb([[product], [staleDraft]]);

    await expect(publish(db, TENANT_ID, adapter, "token-1", "p1")).rejects.toThrow(/no longer matches/);

    expect(createListingMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledWith(
      "ai-generate-url",
      { type: "ai_generate", tenantId: TENANT_ID, productId: "p1" },
      `${TENANT_ID}:ai-generate:p1:hash-1`,
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "ai_draft_stale_regeneration_triggered", entityId: "p1" }),
    );
  });

  it("refuses to publish and never calls the adapter when Shopify is currently isolated", async () => {
    isChannelIsolatedMock.mockResolvedValueOnce({ channel: "shopify", isolated: true, reasons: ["too many failures"], windowMinutes: 15 });
    const createListingMock = vi.fn();
    const adapter = { createListing: createListingMock } as never;
    const db = createFakeDb([[product], [draft], [{ quantity: 10, safetyStockBuffer: 0 }]]);

    await expect(publish(db, TENANT_ID, adapter, "token-1", "p1")).rejects.toThrow(/isolated/);
    expect(createListingMock).not.toHaveBeenCalled();
  });

  it("falls back to the dynamic FX-based price when the draft has no suggestedPriceUsd", async () => {
    const createListingMock = vi.fn().mockResolvedValue({ externalId: "my-store::111" });
    const adapter = { createListing: createListingMock } as never;
    const draftNoPrice = { ...draft, suggestedPriceUsd: null };
    const db = createFakeDb([[product], [draftNoPrice], [{ quantity: 10, safetyStockBuffer: 0 }]]);

    await publish(db, TENANT_ID, adapter, "token-1", "p1");

    expect(fetchFxRateMock).toHaveBeenCalled();
    expect(createListingMock).toHaveBeenCalledWith("token-1", expect.objectContaining({ priceUsd: expect.any(Number) }));
  });
});

describe("update", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
    isChannelIsolatedMock.mockClear().mockResolvedValue({ channel: "shopify", isolated: false, reasons: [], windowMinutes: 15 });
  });

  it("sends only title/description/price to updateListing -- never quantity, which goes through its own separate setInventory call instead", async () => {
    const updateListingMock = vi.fn().mockResolvedValue(undefined);
    const setInventoryMock = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing: updateListingMock, setInventory: setInventoryMock } as never;
    const inventory = { quantity: 10, safetyStockBuffer: 2, version: 1 };
    const db = createFakeDb([[product], [draft], [inventory]]);

    await update(db, TENANT_ID, adapter, "token-1", "p1", "my-store::111");

    expect(updateListingMock).toHaveBeenCalledWith("token-1", "my-store::111", {
      titleEn: "Item",
      descriptionHtmlEn: "<p>d</p>",
      priceUsd: 50,
    });
    expect(db.setMock).toHaveBeenCalledWith(expect.objectContaining({ status: "published", lastSyncedPriceJpy: 10000 }));
    expect(recordAuditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "shopify_listing_updated" }));
  });

  it("re-syncs the current available quantity via setInventory on every update -- found missing by Codex review: a BASE stock-only change routed here by product-fetch used to never actually reach Shopify's inventory", async () => {
    const updateListingMock = vi.fn().mockResolvedValue(undefined);
    const setInventoryMock = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing: updateListingMock, setInventory: setInventoryMock } as never;
    const inventory = { quantity: 10, safetyStockBuffer: 2, version: 1 };
    const db = createFakeDb([[product], [draft], [inventory]]);

    await update(db, TENANT_ID, adapter, "token-1", "p1", "my-store::111");

    // shopify !== product.sourceChannel ("base"), so the safety-stock buffer applies: 10 - 2.
    expect(setInventoryMock).toHaveBeenCalledWith("token-1", "my-store::111", 8);
  });

  it("refuses to update when Shopify is currently isolated", async () => {
    isChannelIsolatedMock.mockResolvedValueOnce({ channel: "shopify", isolated: true, reasons: ["too many failures"], windowMinutes: 15 });
    const updateListingMock = vi.fn();
    const adapter = { updateListing: updateListingMock } as never;
    const db = createFakeDb([[product], [draft]]);

    await expect(update(db, TENANT_ID, adapter, "token-1", "p1", "my-store::111")).rejects.toThrow(/isolated/);
    expect(updateListingMock).not.toHaveBeenCalled();
  });
});
