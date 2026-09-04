import type { EbayAdapter } from "@ai-ec/adapter-ebay";
import { beforeEach, describe, expect, it, vi } from "vitest";

const computeSyncConfidenceMock = vi.fn().mockResolvedValue({
  channel: "ebay",
  score: 100,
  windowHours: 24,
  successCount: 0,
  failureCount: 0,
  outOfOrderEventCount: 0,
  totalEventCount: 0,
});

const computeDynamicSafetyStockMock = vi.fn().mockResolvedValue({
  productId: "p1",
  channel: "ebay",
  recommendedBuffer: 0,
  salesPerDay: 0,
  windowDays: 7,
  pollIntervalMinutes: 1,
  confidenceScore: 100,
  riskMultiplier: 1,
});

const detectInventoryAnomalyMock = vi.fn().mockResolvedValue({
  productId: "p1",
  anomalous: false,
  reasons: [],
  windowMinutes: 60,
  saleEventCount: 0,
  maxSingleSaleQuantity: 0,
});
const detectPriceAnomalyMock = vi.fn().mockReturnValue({ anomalous: false });

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  aiListingDraft: {},
  channelListings: { productId: "productId", channel: "channel" },
  inventoryMaster: {},
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
  computeDynamicSafetyStock: (...args: unknown[]) => computeDynamicSafetyStockMock(...args),
  detectInventoryAnomaly: (...args: unknown[]) => detectInventoryAnomalyMock(...args),
  detectPriceAnomaly: (...args: unknown[]) => detectPriceAnomalyMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  getQueueUrls: () => ({ aiGenerate: "ai-generate-url", ebaySync: "ebay-sync-url", inventorySync: "inv-url" }),
}));

const { publish, update } = await import("./handler.js");

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

const product = { id: "p1", sku: "base-1", sourceChannel: "base", priceJpy: 10000, contentHash: "hash-1" };
const draft = {
  titleEn: "Item",
  descriptionHtmlEn: "<p>d</p>",
  suggestedPriceUsd: null,
  categoryCandidates: [{ ebayCategoryId: "1", label: "Cat" }],
  itemSpecifics: {},
  condition: "USED_GOOD",
  sourceContentHash: "hash-1",
};
// The channel_listings row read for the anomaly-detection price baseline. null
// lastSyncedPriceJpy (never synced before) is always non-anomalous.
const listing = { lastSyncedPriceJpy: null };

describe("publish", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
    enqueueMock.mockClear();
    computeSyncConfidenceMock.mockClear();
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 100,
      windowHours: 24,
      successCount: 0,
      failureCount: 0,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });
    computeDynamicSafetyStockMock.mockClear();
    computeDynamicSafetyStockMock.mockResolvedValue({
      productId: "p1",
      channel: "ebay",
      recommendedBuffer: 0,
      salesPerDay: 0,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 100,
      riskMultiplier: 1,
    });
    detectInventoryAnomalyMock.mockClear();
    detectInventoryAnomalyMock.mockResolvedValue({
      productId: "p1",
      anomalous: false,
      reasons: [],
      windowMinutes: 60,
      saleEventCount: 0,
      maxSingleSaleQuantity: 0,
    });
    detectPriceAnomalyMock.mockClear();
    detectPriceAnomalyMock.mockReturnValue({ anomalous: false });
  });

  function ebayAdapter(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      createListing: vi.fn().mockResolvedValue({ externalId: "base-1" }),
      getApplicationAccessToken: vi.fn().mockResolvedValue("app-token"),
      getRequiredItemAspects: vi.fn().mockResolvedValue([]),
      ...overrides,
    } as unknown as EbayAdapter;
  }

  it("withholds the freshly-computed dynamic safety stock buffer from the quantity pushed to eBay", async () => {
    computeDynamicSafetyStockMock.mockResolvedValue({
      productId: "p1",
      channel: "ebay",
      recommendedBuffer: 2,
      salesPerDay: 1,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 100,
      riskMultiplier: 1,
    });
    const inventory = { quantity: 5, safetyStockBuffer: 999 }; // stale stored value must be ignored
    const adapter = ebayAdapter();

    await publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledWith("token", expect.objectContaining({ quantity: 3 }));
    expect(computeDynamicSafetyStockMock).toHaveBeenCalledWith(expect.anything(), "p1", "ebay");
  });

  it("pushes 0 rather than negative when the computed buffer exceeds true stock", async () => {
    computeDynamicSafetyStockMock.mockResolvedValue({
      productId: "p1",
      channel: "ebay",
      recommendedBuffer: 5,
      salesPerDay: 5,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 100,
      riskMultiplier: 1,
    });
    const inventory = { quantity: 1, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledWith("token", expect.objectContaining({ quantity: 0 }));
  });

  it("blocks the publish before calling createListing when eBay-required item specifics are missing", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter({ getRequiredItemAspects: vi.fn().mockResolvedValue(["Brand", "Type"]) });
    // draft.itemSpecifics is {} — neither Brand nor Type is set.

    await expect(publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1")).rejects.toThrow(
      /Brand, Type/,
    );
    expect(adapter.createListing).not.toHaveBeenCalled();
  });

  it("publishes once every eBay-required item specific is present", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const draftWithSpecifics = { ...draft, itemSpecifics: { Brand: "Unbranded", Type: "Bracelet" } };
    const adapter = ebayAdapter({ getRequiredItemAspects: vi.fn().mockResolvedValue(["Brand", "Type"]) });

    await publish(createFakeDb([[product], [draftWithSpecifics], [listing], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledTimes(1);
  });

  it("passes the draft's condition through instead of hardcoding NEW", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledWith("token", expect.objectContaining({ condition: "USED_GOOD" }));
  });

  it("blocks a new publish when eBay's sync confidence is too low, without calling createListing", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 20,
      windowHours: 24,
      successCount: 1,
      failureCount: 4,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await expect(publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1")).rejects.toThrow(
      /sync confidence too low/,
    );
    expect(adapter.createListing).not.toHaveBeenCalled();
  });

  it("publishes normally once confidence is back above the threshold", async () => {
    computeSyncConfidenceMock.mockResolvedValue({
      channel: "ebay",
      score: 41,
      windowHours: 24,
      successCount: 9,
      failureCount: 1,
      outOfOrderEventCount: 0,
      totalEventCount: 0,
    });
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledTimes(1);
  });

  it("blocks publish and enqueues regeneration when the draft's content hash is stale", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const staleDraft = { ...draft, sourceContentHash: "hash-0" };
    const adapter = ebayAdapter();

    await expect(
      publish(createFakeDb([[product], [staleDraft], [listing], [inventory]]), adapter, "token", "p1"),
    ).rejects.toThrow(/no longer matches the product's current content/);

    expect(adapter.createListing).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledWith(
      "ai-generate-url",
      { type: "ai_generate", productId: "p1" },
      "ai-generate:p1:hash-1",
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "ai_draft_stale_regeneration_triggered", entityId: "p1" }),
    );
  });

  it("blocks publish and records an audit log when inventory activity looks anomalous", async () => {
    detectInventoryAnomalyMock.mockResolvedValue({
      productId: "p1",
      anomalous: true,
      reasons: ["6 sale events for this product in the last 60min (threshold 5)"],
      windowMinutes: 60,
      saleEventCount: 6,
      maxSingleSaleQuantity: 1,
    });
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await expect(
      publish(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1"),
    ).rejects.toThrow(/unusual activity detected/);

    expect(adapter.createListing).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "anomaly_detected_sync_paused", entityId: "p1" }),
    );
  });

  it("blocks publish when the candidate price swings too far from the last price synced to eBay", async () => {
    detectPriceAnomalyMock.mockReturnValue({
      anomalous: true,
      reason: "price would change 90% versus the last price synced to eBay",
    });
    const staleListing = { lastSyncedPriceJpy: 100000 };
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await expect(
      publish(createFakeDb([[product], [draft], [staleListing], [inventory]]), adapter, "token", "p1"),
    ).rejects.toThrow(/unusual activity detected/);

    expect(adapter.createListing).not.toHaveBeenCalled();
    expect(detectPriceAnomalyMock).toHaveBeenCalledWith(100000, product.priceJpy);
  });

  it("records the just-published price as the new lastSyncedPriceJpy baseline", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();
    const db = createFakeDb([[product], [draft], [listing], [inventory]]);

    await publish(db, adapter, "token", "p1");

    expect(db.setMock).toHaveBeenCalledWith(expect.objectContaining({ lastSyncedPriceJpy: product.priceJpy }));
  });
});

describe("update", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
    enqueueMock.mockClear();
    computeDynamicSafetyStockMock.mockClear();
    computeDynamicSafetyStockMock.mockResolvedValue({
      productId: "p1",
      channel: "ebay",
      recommendedBuffer: 0,
      salesPerDay: 0,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 100,
      riskMultiplier: 1,
    });
    detectInventoryAnomalyMock.mockClear();
    detectInventoryAnomalyMock.mockResolvedValue({
      productId: "p1",
      anomalous: false,
      reasons: [],
      windowMinutes: 60,
      saleEventCount: 0,
      maxSingleSaleQuantity: 0,
    });
    detectPriceAnomalyMock.mockClear();
    detectPriceAnomalyMock.mockReturnValue({ anomalous: false });
  });

  it("re-syncs the quantity, buffered by the freshly-computed dynamic safety stock", async () => {
    computeDynamicSafetyStockMock.mockResolvedValue({
      productId: "p1",
      channel: "ebay",
      recommendedBuffer: 3,
      salesPerDay: 1,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 100,
      riskMultiplier: 1,
    });
    const inventory = { quantity: 8, safetyStockBuffer: 999 }; // stale stored value must be ignored
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await update(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith(
      "token",
      "base-1",
      expect.objectContaining({ quantity: 5, condition: "USED_GOOD" }),
    );
  });

  it("always resends item specifics, so a required aspect wiped by an earlier failed PUT gets restored", async () => {
    const inventory = { quantity: 8, safetyStockBuffer: 3 };
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;
    const draftWithSpecifics = { ...draft, itemSpecifics: { Type: "Bracelet", Brand: "Unbranded" } };

    await update(createFakeDb([[product], [draftWithSpecifics], [listing], [inventory]]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith(
      "token",
      "base-1",
      expect.objectContaining({ itemSpecifics: { Type: "Bracelet", Brand: "Unbranded" } }),
    );
  });

  it("leaves quantity undefined when there is no inventory_master row yet", async () => {
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await update(createFakeDb([[product], [draft], [listing], []]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith("token", "base-1", expect.objectContaining({ quantity: undefined }));
  });

  it("blocks update and enqueues regeneration when the draft's content hash is stale", async () => {
    const inventory = { quantity: 8, safetyStockBuffer: 0 };
    const staleDraft = { ...draft, sourceContentHash: "hash-0" };
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await expect(
      update(createFakeDb([[product], [staleDraft], [listing], [inventory]]), adapter, "token", "p1", "base-1"),
    ).rejects.toThrow(/no longer matches the product's current content/);

    expect(updateListing).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledWith(
      "ai-generate-url",
      { type: "ai_generate", productId: "p1" },
      "ai-generate:p1:hash-1",
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "ai_draft_stale_regeneration_triggered", entityId: "p1" }),
    );
  });

  it("blocks update and records an audit log when inventory activity looks anomalous", async () => {
    detectInventoryAnomalyMock.mockResolvedValue({
      productId: "p1",
      anomalous: true,
      reasons: ["a single sale event moved 15 units (threshold 10)"],
      windowMinutes: 60,
      saleEventCount: 1,
      maxSingleSaleQuantity: 15,
    });
    const inventory = { quantity: 8, safetyStockBuffer: 0 };
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await expect(
      update(createFakeDb([[product], [draft], [listing], [inventory]]), adapter, "token", "p1", "base-1"),
    ).rejects.toThrow(/unusual activity detected/);

    expect(updateListing).not.toHaveBeenCalled();
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "anomaly_detected_sync_paused", entityId: "p1" }),
    );
  });

  it("records the just-updated price as the new lastSyncedPriceJpy baseline", async () => {
    const inventory = { quantity: 8, safetyStockBuffer: 0 };
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;
    const db = createFakeDb([[product], [draft], [listing], [inventory]]);

    await update(db, adapter, "token", "p1", "base-1");

    expect(db.setMock).toHaveBeenCalledWith(expect.objectContaining({ lastSyncedPriceJpy: product.priceJpy }));
  });
});
