import type { ExternalProduct } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyBaseStockReportMock = vi.fn().mockResolvedValue({ applied: true, quantity: 5 });
const getTenantBillingStatusMock = vi.fn().mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
const countProductsMock = vi.fn().mockResolvedValue(0);
vi.mock("@ai-ec/db", () => ({
  productMaster: { __table: "productMaster", sku: "sku" },
  inventoryMaster: { __table: "inventoryMaster" },
  channelListings: { __table: "channelListings", productId: "productId", channel: "channel" },
  syncJobs: { __table: "syncJobs", tenantId: "tenantId", idempotencyKey: "idempotencyKey", id: "id", type: "type", status: "status" },
  applyBaseStockReport: (...args: unknown[]) => applyBaseStockReportMock(...args),
  getTenantBillingStatus: (...args: unknown[]) => getTenantBillingStatusMock(...args),
  countProducts: (...args: unknown[]) => countProductsMock(...args),
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/lambda-shared", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const { upsertProduct, dispatchPendingOutboxJobs } = await import("./handler.js");

const queues = { aiGenerate: "ai-generate-url", ebaySync: "ebay-sync-url", inventorySync: "inv-url" };
const TENANT_ID = "tenant-a";

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

interface FakeProductRow {
  id: string;
  contentHash: string;
  [key: string]: unknown;
}

interface FakeJobRow {
  id: string;
  tenantId: string;
  type: string;
  idempotencyKey: string;
  productId: string | null;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
}

interface FakeDbOptions {
  existingProduct?: FakeProductRow | null;
  ebayListing?: { status: string } | null;
  insertedProductId?: string;
  /** Shared across calls so tests can drive two upsertProduct/dispatchPendingOutboxJobs
   *  invocations against the same underlying outbox state (dedup, then dispatch). */
  jobsStore?: FakeJobRow[];
  /** Simulates a failure that happens *inside* the transaction, right after the outbox row
   *  would have been inserted -- proves the whole transaction (product change + outbox
   *  row) rolls back together rather than leaving an orphaned outbox row behind. */
  throwAfterOutboxInsert?: boolean;
}

/**
 * A single stateful fake spanning everything upsertProduct and dispatchPendingOutboxJobs
 * touch: productMaster (select/update/insert), channelListings (select), and syncJobs
 * (insert with a real (tenantId, idempotencyKey) dedup guard, and the multi-row
 * select/sequential-update dispatchPendingOutboxJobs itself uses) -- table identity is
 * tracked via each mocked table's own `__table` marker rather than drizzle's real Symbol
 * name (unavailable once @ai-ec/db itself is mocked).
 */
function createFakeDb(opts: FakeDbOptions) {
  const jobsStore = opts.jobsStore ?? [];
  let productRow: FakeProductRow | null = opts.existingProduct ? { ...opts.existingProduct } : null;
  let jobIdCounter = 0;
  const productUpdateCalls: Record<string, unknown>[] = [];
  let dispatchTargets: FakeJobRow[] = [];
  let dispatchCursor = 0;

  function makeQueryable(pendingJobs: FakeJobRow[]) {
    return {
      select: () => ({
        from: (table: { __table?: string }) => {
          if (table.__table === "syncJobs") {
            return {
              where: () => {
                // Serves two real call sites with different shapes: dispatchPendingOutboxJobs
                // awaits this directly (bulk query, no .limit()); insertOutboxJob's
                // post-conflict fallback lookup chains .limit(1) instead. The fallback's
                // result is never inspected by upsertProduct (fire-and-forget), so it's
                // safe to always resolve it to an empty match here.
                dispatchTargets = jobsStore.filter((j) => j.status === "pending" || j.status === "failed");
                dispatchCursor = 0;
                const p = Promise.resolve(dispatchTargets) as Promise<FakeJobRow[]> & { limit?: (n: number) => Promise<FakeJobRow[]> };
                p.limit = async () => [];
                return p;
              },
            };
          }
          return {
            where: () => ({
              limit: async () => {
                if (table.__table === "productMaster") {
                  return productRow ? [productRow] : [];
                }
                if (table.__table === "channelListings") {
                  return opts.ebayListing ? [opts.ebayListing] : [];
                }
                return [];
              },
            }),
          };
        },
      }),
      update: (table: { __table?: string }) => ({
        set: (v: Record<string, unknown>) => ({
          where: async () => {
            if (table.__table === "productMaster" && productRow) {
              productUpdateCalls.push(v);
              Object.assign(productRow, v);
            } else if (table.__table === "syncJobs") {
              const job = dispatchTargets[dispatchCursor];
              dispatchCursor += 1;
              if (job) Object.assign(job, v);
            }
          },
        }),
      }),
      insert: (table: { __table?: string }) => ({
        values: (v: Record<string, unknown>) => {
          if (table.__table === "productMaster") {
            return insertResult([{ id: opts.insertedProductId ?? "new-product-id" }]);
          }
          if (table.__table === "syncJobs") {
            return {
              onConflictDoNothing: () => {
                const key = `${v.tenantId as string}:${v.idempotencyKey as string}`;
                const alreadyExists =
                  jobsStore.some((j) => `${j.tenantId}:${j.idempotencyKey}` === key) ||
                  pendingJobs.some((j) => `${j.tenantId}:${j.idempotencyKey}` === key);
                if (alreadyExists) {
                  return insertResult([]);
                }
                jobIdCounter += 1;
                const row: FakeJobRow = {
                  id: `job-${jobIdCounter}`,
                  status: "pending",
                  attempts: 0,
                  tenantId: v.tenantId as string,
                  type: v.type as string,
                  idempotencyKey: v.idempotencyKey as string,
                  productId: (v.productId as string) ?? null,
                  payload: v.payload as Record<string, unknown>,
                };
                pendingJobs.push(row);
                if (opts.throwAfterOutboxInsert) {
                  throw new Error("simulated mid-transaction failure");
                }
                return insertResult([row]);
              },
            };
          }
          void v;
          return insertResult(undefined);
        },
      }),
      execute: async () => undefined,
    };
  }

  return {
    ...makeQueryable(jobsStore),
    transaction: async (fn: (tx: ReturnType<typeof makeQueryable>) => Promise<unknown>) => {
      const pendingJobs: FakeJobRow[] = [];
      const productSnapshot = productRow ? { ...productRow } : null;
      try {
        const result = await fn(makeQueryable(pendingJobs));
        jobsStore.push(...pendingJobs); // "commit": only now do outbox rows become visible
        return result;
      } catch (err) {
        productRow = productSnapshot; // "rollback": undo any product mutation from this attempt
        throw err; // pendingJobs is simply discarded -- never reaches jobsStore
      }
    },
    getProductRow: () => productRow,
    getProductUpdateCalls: () => productUpdateCalls,
  } as never;
}

describe("upsertProduct", () => {
  beforeEach(() => {
    enqueueMock.mockReset().mockResolvedValue(undefined);
    applyBaseStockReportMock.mockClear();
    recordAuditLogMock.mockClear();
    recordSyncErrorMock.mockClear();
    getTenantBillingStatusMock.mockClear().mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
    countProductsMock.mockClear().mockResolvedValue(0);
  });

  it("reconciles BASE's reported stock into inventory_master on every poll of an existing product, even when nothing else changed", async () => {
    const { contentHash } = await import("@ai-ec/core");
    const hash = contentHash({ title: item.title, descriptionHtml: item.descriptionHtml, priceJpy: item.priceJpy, images: item.images });
    const db = createFakeDb({ existingProduct: { id: "existing-id", contentHash: hash } });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(applyBaseStockReportMock).toHaveBeenCalledWith(db, TENANT_ID, "existing-id", item.quantity, item.updatedAt);
  });

  it("does not attempt stock reconciliation for a brand-new product (nothing to reconcile against yet)", async () => {
    const db = createFakeDb({ existingProduct: null });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(applyBaseStockReportMock).not.toHaveBeenCalled();
  });

  it("inserts a brand-new product, its inventory/base listing rows, and a pending ai_generate outbox job -- never enqueuing directly", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    await upsertProduct(db, TENANT_ID, item, true);

    // The product-fetch DB write and the SQS enqueue are no longer the same operation --
    // upsertProduct only ever commits the outbox row; dispatchPendingOutboxJobs is what
    // actually calls SQS, on a separate pass. This is the core of the outbox fix.
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(jobsStore).toHaveLength(1);
    expect(jobsStore[0]).toMatchObject({
      type: "ai_generate",
      status: "pending",
      idempotencyKey: `${TENANT_ID}:ai-generate:new-product-id`,
      payload: { type: "ai_generate", tenantId: TENANT_ID, productId: "new-product-id" },
    });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "product_listed_base", entityId: "new-product-id" }),
    );
  });

  it("does nothing when the content hash is unchanged since the last poll", async () => {
    const { contentHash } = await import("@ai-ec/core");
    const hash = contentHash({ title: item.title, descriptionHtml: item.descriptionHtml, priceJpy: item.priceJpy, images: item.images });
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: { id: "existing-id", contentHash: hash }, jobsStore });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(0);
  });

  it("updates the product but creates no outbox job when no eBay listing exists yet", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: { id: "existing-id", contentHash: "stale-hash" }, ebayListing: null, jobsStore });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(0);
  });

  it("does not push an edit to eBay while the listing is still pending human approval", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "pending_approval" },
      jobsStore,
    });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(0);
  });

  it("product update + eBay update job: a BASE edit to a product with an already-published eBay listing commits the update and a pending ebay_update outbox job in one transaction", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "published" },
      jobsStore,
    });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect((db as unknown as { getProductUpdateCalls: () => unknown[] }).getProductUpdateCalls()).toHaveLength(1);
    expect(jobsStore).toHaveLength(1);
    expect(jobsStore[0]).toMatchObject({
      type: "ebay_update",
      status: "pending",
      productId: "existing-id",
      payload: { type: "ebay_update", tenantId: TENANT_ID, productId: "existing-id" },
    });
    expect(jobsStore[0]!.idempotencyKey).toContain(`${TENANT_ID}:ebay-update:existing-id:`);
  });

  it("同じcontentHashで重複jobなし: two overlapping upserts for the same change never create two outbox jobs", async () => {
    const jobsStore: FakeJobRow[] = [];
    const dbA = createFakeDb({ existingProduct: { id: "existing-id", contentHash: "stale-hash" }, ebayListing: { status: "published" }, jobsStore });
    const dbB = createFakeDb({ existingProduct: { id: "existing-id", contentHash: "stale-hash" }, ebayListing: { status: "published" }, jobsStore });

    await upsertProduct(dbA, TENANT_ID, item, true);
    await upsertProduct(dbB, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(1); // the second insert's idempotencyKey conflicts with the first's
  });

  it("DB rollback時outboxだけ残らない: a failure inside the transaction after the outbox insert leaves neither the product update nor the outbox row committed", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "published" },
      jobsStore,
      throwAfterOutboxInsert: true,
    });

    await expect(upsertProduct(db, TENANT_ID, item, true)).rejects.toThrow("simulated mid-transaction failure");

    expect(jobsStore).toHaveLength(0); // never committed
    expect((db as unknown as { getProductRow: () => FakeProductRow | null }).getProductRow()).toMatchObject({ contentHash: "stale-hash" }); // update rolled back
  });

  it("skips creating a new product and records a sync error once the tenant is at its plan's product limit", async () => {
    countProductsMock.mockResolvedValue(300);
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(0);
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ tenantId: TENANT_ID, errorCode: "product_quota_exceeded" }),
    );
  });

  it("still allows creating a new product just under the plan's product limit", async () => {
    countProductsMock.mockResolvedValue(299);
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    await upsertProduct(db, TENANT_ID, item, true);

    expect(jobsStore).toHaveLength(1);
    expect(recordSyncErrorMock).not.toHaveBeenCalled();
  });

  it("runs the quota check and the insert inside one transaction, not two separate round-trips", async () => {
    countProductsMock.mockResolvedValue(299);
    const db = createFakeDb({ existingProduct: null });
    const transactionSpy = vi.spyOn(db as unknown as { transaction: (...a: unknown[]) => unknown }, "transaction");

    await upsertProduct(db, TENANT_ID, item, true);

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    const [txArg] = countProductsMock.mock.calls.at(-1)!;
    expect(txArg).not.toBe(db);
  });

  it("canceledで新規syncなし: does not onboard a brand-new product when the tenant isn't allowed to (past_due/canceled_grace/canceled-not-yet-offboarded)", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: null, jobsStore });
    const transactionSpy = vi.spyOn(db as unknown as { transaction: (...a: unknown[]) => unknown }, "transaction");

    await upsertProduct(db, TENANT_ID, item, false);

    expect(jobsStore).toHaveLength(0);
    expect(transactionSpy).not.toHaveBeenCalled(); // never even attempts the quota-check/insert
    expect(countProductsMock).not.toHaveBeenCalled();
    expect(recordSyncErrorMock).not.toHaveBeenCalled(); // silently skipped, not treated as an error
  });

  it("still reconciles stock and syncs an existing product's changes to eBay even when the tenant may not onboard NEW products", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({ existingProduct: { id: "existing-id", contentHash: "stale-hash" }, ebayListing: { status: "published" }, jobsStore });

    await upsertProduct(db, TENANT_ID, item, false);

    expect(applyBaseStockReportMock).toHaveBeenCalledWith(db, TENANT_ID, "existing-id", item.quantity, item.updatedAt);
    expect(jobsStore).toHaveLength(1);
    expect(jobsStore[0]).toMatchObject({ type: "ebay_update", status: "pending" });
  });
});

describe("dispatchPendingOutboxJobs", () => {
  beforeEach(() => {
    enqueueMock.mockReset().mockResolvedValue(undefined);
    recordSyncErrorMock.mockClear();
  });

  it("new product作成後SQS障害 → outbox残る, then 次dispatcherで送信成功: a failed dispatch leaves the job retryable, and the next pass sends it", async () => {
    const job: FakeJobRow = {
      id: "job-1",
      tenantId: TENANT_ID,
      type: "ai_generate",
      idempotencyKey: `${TENANT_ID}:ai-generate:p1`,
      productId: "p1",
      payload: { type: "ai_generate", tenantId: TENANT_ID, productId: "p1" },
      status: "pending",
      attempts: 0,
    };
    const jobsStore = [job];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    enqueueMock.mockRejectedValueOnce(new Error("SQS unavailable"));
    await dispatchPendingOutboxJobs(db, queues, TENANT_ID);

    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ tenantId: TENANT_ID, productId: "p1", errorCode: "product_fetch_dispatch_failed" }),
    );

    // A later dispatcher pass re-reads this still-"failed" job (status IN pending/failed)
    // and retries it -- this time SQS accepts it.
    enqueueMock.mockResolvedValueOnce(undefined);
    await dispatchPendingOutboxJobs(db, queues, TENANT_ID);

    expect(job.status).toBe("completed");
    expect(enqueueMock).toHaveBeenLastCalledWith(queues.aiGenerate, job.payload, job.idempotencyKey);
  });

  it("dispatches an ebay_update job to the eBay sync queue and a ai_generate job to the AI generate queue", async () => {
    const aiJob: FakeJobRow = {
      id: "job-1",
      tenantId: TENANT_ID,
      type: "ai_generate",
      idempotencyKey: `${TENANT_ID}:ai-generate:p1`,
      productId: "p1",
      payload: { type: "ai_generate", tenantId: TENANT_ID, productId: "p1" },
      status: "pending",
      attempts: 0,
    };
    const ebayJob: FakeJobRow = {
      id: "job-2",
      tenantId: TENANT_ID,
      type: "ebay_update",
      idempotencyKey: `${TENANT_ID}:ebay-update:p2:hash`,
      productId: "p2",
      payload: { type: "ebay_update", tenantId: TENANT_ID, productId: "p2" },
      status: "pending",
      attempts: 0,
    };
    const jobsStore = [aiJob, ebayJob];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    await dispatchPendingOutboxJobs(db, queues, TENANT_ID);

    expect(enqueueMock).toHaveBeenCalledWith(queues.aiGenerate, aiJob.payload, aiJob.idempotencyKey);
    expect(enqueueMock).toHaveBeenCalledWith(queues.ebaySync, ebayJob.payload, ebayJob.idempotencyKey);
    expect(aiJob.status).toBe("completed");
    expect(ebayJob.status).toBe("completed");
  });

  it("SQS failureでDB商品変更は失われない: a dispatch failure only ever mutates the outbox job's own status, never the product row it describes", async () => {
    const jobsStore: FakeJobRow[] = [];
    const db = createFakeDb({
      existingProduct: { id: "existing-id", contentHash: "stale-hash" },
      ebayListing: { status: "published" },
      jobsStore,
    });

    await upsertProduct(db, TENANT_ID, item, true);
    expect(jobsStore).toHaveLength(1);
    const productRowAfterCommit = { ...(db as unknown as { getProductRow: () => FakeProductRow | null }).getProductRow() };

    enqueueMock.mockRejectedValueOnce(new Error("SQS down"));
    await dispatchPendingOutboxJobs(db, queues, TENANT_ID);

    expect(jobsStore[0]!.status).toBe("failed"); // only the outbox row's status changed
    expect((db as unknown as { getProductRow: () => FakeProductRow | null }).getProductRow()).toEqual(productRowAfterCommit); // product untouched
  });

  it("does not touch a job whose type it does not recognize", async () => {
    const job: FakeJobRow = {
      id: "job-1",
      tenantId: TENANT_ID,
      type: "some_other_job_type",
      idempotencyKey: "k",
      productId: null,
      payload: {},
      status: "pending",
      attempts: 0,
    };
    const jobsStore = [job];
    const db = createFakeDb({ existingProduct: null, jobsStore });

    await dispatchPendingOutboxJobs(db, queues, TENANT_ID);

    expect(enqueueMock).not.toHaveBeenCalled();
    expect(job.status).toBe("pending");
  });
});
