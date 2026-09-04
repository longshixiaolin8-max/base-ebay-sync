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

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  aiListingDraft: {},
  channelListings: { productId: "productId", channel: "channel" },
  inventoryMaster: {},
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
  computeDynamicSafetyStock: (...args: unknown[]) => computeDynamicSafetyStockMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
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

function createFakeDb(selectResults: unknown[]) {
  let i = 0;
  return {
    select: () => chain(selectResults[i++]),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
  } as never;
}

const product = { id: "p1", sku: "base-1", sourceChannel: "base", priceJpy: 10000 };
const draft = {
  titleEn: "Item",
  descriptionHtmlEn: "<p>d</p>",
  suggestedPriceUsd: null,
  categoryCandidates: [{ ebayCategoryId: "1", label: "Cat" }],
  itemSpecifics: {},
  condition: "USED_GOOD",
};

describe("publish", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
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

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

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

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledWith("token", expect.objectContaining({ quantity: 0 }));
  });

  it("blocks the publish before calling createListing when eBay-required item specifics are missing", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter({ getRequiredItemAspects: vi.fn().mockResolvedValue(["Brand", "Type"]) });
    // draft.itemSpecifics is {} — neither Brand nor Type is set.

    await expect(publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1")).rejects.toThrow(
      /Brand, Type/,
    );
    expect(adapter.createListing).not.toHaveBeenCalled();
  });

  it("publishes once every eBay-required item specific is present", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const draftWithSpecifics = { ...draft, itemSpecifics: { Brand: "Unbranded", Type: "Bracelet" } };
    const adapter = ebayAdapter({ getRequiredItemAspects: vi.fn().mockResolvedValue(["Brand", "Type"]) });

    await publish(createFakeDb([[product], [draftWithSpecifics], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledTimes(1);
  });

  it("passes the draft's condition through instead of hardcoding NEW", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 0 };
    const adapter = ebayAdapter();

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

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

    await expect(publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1")).rejects.toThrow(
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

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

    expect(adapter.createListing).toHaveBeenCalledTimes(1);
  });
});

describe("update", () => {
  beforeEach(() => {
    recordAuditLogMock.mockClear();
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

    await update(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1", "base-1");

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

    await update(createFakeDb([[product], [draftWithSpecifics], [inventory]]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith(
      "token",
      "base-1",
      expect.objectContaining({ itemSpecifics: { Type: "Bracelet", Brand: "Unbranded" } }),
    );
  });

  it("leaves quantity undefined when there is no inventory_master row yet", async () => {
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await update(createFakeDb([[product], [draft], []]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith("token", "base-1", expect.objectContaining({ quantity: undefined }));
  });
});
