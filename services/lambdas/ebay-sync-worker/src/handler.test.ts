import type { EbayAdapter } from "@ai-ec/adapter-ebay";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  aiListingDraft: {},
  channelListings: { productId: "productId", channel: "channel" },
  inventoryMaster: {},
  calculateChannelAvailableQuantity: (trueQuantity: number, buffer: number, channel: string, sourceChannel: string) =>
    channel === sourceChannel ? trueQuantity : Math.max(0, trueQuantity - buffer),
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
};

describe("publish", () => {
  beforeEach(() => recordAuditLogMock.mockClear());

  it("withholds the safety stock buffer from the quantity pushed to eBay", async () => {
    const inventory = { quantity: 5, safetyStockBuffer: 2 };
    const createListing = vi.fn().mockResolvedValue({ externalId: "base-1" });
    const adapter = { createListing } as unknown as EbayAdapter;

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

    expect(createListing).toHaveBeenCalledWith("token", expect.objectContaining({ quantity: 3 }));
  });

  it("pushes 0 rather than negative when the buffer exceeds true stock", async () => {
    const inventory = { quantity: 1, safetyStockBuffer: 5 };
    const createListing = vi.fn().mockResolvedValue({ externalId: "base-1" });
    const adapter = { createListing } as unknown as EbayAdapter;

    await publish(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1");

    expect(createListing).toHaveBeenCalledWith("token", expect.objectContaining({ quantity: 0 }));
  });
});

describe("update", () => {
  beforeEach(() => recordAuditLogMock.mockClear());

  it("re-syncs the buffered quantity alongside content changes", async () => {
    const inventory = { quantity: 8, safetyStockBuffer: 3 };
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await update(createFakeDb([[product], [draft], [inventory]]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith("token", "base-1", expect.objectContaining({ quantity: 5 }));
  });

  it("leaves quantity undefined when there is no inventory_master row yet", async () => {
    const updateListing = vi.fn().mockResolvedValue(undefined);
    const adapter = { updateListing } as unknown as EbayAdapter;

    await update(createFakeDb([[product], [draft], []]), adapter, "token", "p1", "base-1");

    expect(updateListing).toHaveBeenCalledWith("token", "base-1", expect.objectContaining({ quantity: undefined }));
  });
});
