import type { ExternalProduct } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-ec/db", () => ({
  productMaster: { sku: "sku" },
  inventoryMaster: {},
  channelListings: { productId: "productId", channel: "channel" },
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
}));

const { upsertProduct } = await import("./handler.js");

const queues = { aiGenerate: "ai-generate-url", ebaySync: "ebay-sync-url", inventorySync: "inv-url" };

const item: ExternalProduct = {
  externalId: "item-1",
  title: "T-Shirt",
  descriptionHtml: "<p>desc</p>",
  priceJpy: 3000,
  quantity: 5,
  images: ["https://img.example/1.jpg"],
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

function insertResult(returningValue: unknown) {
  const promise = Promise.resolve(undefined) as Promise<undefined> & { returning?: () => Promise<unknown> };
  promise.returning = async () => returningValue;
  return promise;
}

interface FakeDbOptions {
  existingProduct?: { id: string; contentHash: string } | null;
  ebayListing?: { status: string } | null;
  insertedProductId?: string;
}

function createFakeDb(opts: FakeDbOptions) {
  const insertedProductId = opts.insertedProductId ?? "new-product-id";
  let selectCallCount = 0;

  return {
    select: () => ({
      from: (table: { productId?: string }) => ({
        where: () => ({
          limit: async () => {
            selectCallCount += 1;
            // First select() call is always the productMaster-by-sku lookup.
            if (selectCallCount === 1) {
              return opts.existingProduct ? [opts.existingProduct] : [];
            }
            // Any subsequent select() is the ebay channel_listings lookup.
            void table;
            return opts.ebayListing ? [opts.ebayListing] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: vi.fn(() => ({ where: async () => undefined })),
    }),
    insert: (table: { sku?: string }) => ({
      values: (v: unknown) => {
        if (table.sku !== undefined) {
          // productMaster insert -> caller awaits .returning()
          return insertResult([{ id: insertedProductId }]);
        }
        void v;
        return insertResult(undefined);
      },
    }),
  } as never;
}

describe("upsertProduct", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
  });

  it("inserts a brand-new product, its inventory/base listing rows, and enqueues ai_generate", async () => {
    const db = createFakeDb({ existingProduct: null });

    await upsertProduct(db, queues, item);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      queues.aiGenerate,
      { type: "ai_generate", productId: "new-product-id" },
      "ai-generate:new-product-id",
    );
  });

  it("does nothing when the content hash is unchanged since the last poll", async () => {
    // Same hash the real contentHash() would compute for `item` — precomputed so the
    // no-op branch is taken without needing to import the hashing function here too.
    const { contentHash } = await import("@ai-ec/core");
    const hash = contentHash({
      title: item.title,
      descriptionHtml: item.descriptionHtml,
      priceJpy: item.priceJpy,
      images: item.images,
    });
    const db = createFakeDb({ existingProduct: { id: "existing-id", contentHash: hash } });

    await upsertProduct(db, queues, item);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("updates the product but does not touch eBay when no eBay listing exists yet", async () => {
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: null,
    });

    await upsertProduct(db, queues, item);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("does not push an edit to eBay while the listing is still pending human approval", async () => {
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "pending_approval" },
    });

    await upsertProduct(db, queues, item);

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("enqueues ebay_update when a BASE edit changes a product with an already-published eBay listing", async () => {
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "published" },
    });

    await upsertProduct(db, queues, item);

    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenCalledWith(
      queues.ebaySync,
      { type: "ebay_update", productId: "existing-id" },
      expect.stringContaining("ebay-update:existing-id:"),
    );
  });
});
