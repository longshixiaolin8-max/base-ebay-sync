import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { getSyncJobByIdempotencyKey, insertSyncJob, markSyncJobCompleted, markSyncJobFailed } from "./sync-jobs.js";

describe("insertSyncJob", () => {
  it("inserts a new pending job row and returns it", async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted = v;
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: "job-1", ...v }],
            }),
          };
        },
      }),
    } as unknown as Database;

    const result = await insertSyncJob(db, {
      tenantId: "tenant-a",
      type: "ebay_tracking_upload",
      idempotencyKey: "tenant-a:ebay-tracking-upload:order-1",
      productId: "product-1",
      payload: { orderId: "order-1" },
    });

    expect(inserted).toMatchObject({ tenantId: "tenant-a", status: "pending" });
    expect(result).toMatchObject({ id: "job-1" });
  });

  it("returns the existing row instead of a duplicate when the idempotency key already exists", async () => {
    const existingRow = { id: "existing-job", tenantId: "tenant-a", idempotencyKey: "tenant-a:ebay-tracking-upload:order-1", attempts: 1 };
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [], // conflict -- nothing inserted
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [existingRow],
          }),
        }),
      }),
    } as unknown as Database;

    const result = await insertSyncJob(db, {
      tenantId: "tenant-a",
      type: "ebay_tracking_upload",
      idempotencyKey: "tenant-a:ebay-tracking-upload:order-1",
      productId: "product-1",
      payload: {},
    });

    expect(result).toEqual(existingRow);
  });
});

describe("getSyncJobByIdempotencyKey", () => {
  it("returns the matching row", async () => {
    const row = { id: "job-1" };
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) } as unknown as Database;
    await expect(getSyncJobByIdempotencyKey(db, "tenant-a", "key")).resolves.toEqual(row);
  });

  it("returns undefined when no job matches", async () => {
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) } as unknown as Database;
    await expect(getSyncJobByIdempotencyKey(db, "tenant-a", "key")).resolves.toBeUndefined();
  });
});

describe("markSyncJobCompleted / markSyncJobFailed", () => {
  it("sets status completed", async () => {
    let patch: Record<string, unknown> | undefined;
    const db = { update: () => ({ set: (v: Record<string, unknown>) => { patch = v; return { where: async () => {} }; } }) } as unknown as Database;
    await markSyncJobCompleted(db, "job-1");
    expect(patch).toMatchObject({ status: "completed" });
  });

  it("sets status failed and increments attempts", async () => {
    let patch: Record<string, unknown> | undefined;
    const db = { update: () => ({ set: (v: Record<string, unknown>) => { patch = v; return { where: async () => {} }; } }) } as unknown as Database;
    await markSyncJobFailed(db, "job-1", 2);
    expect(patch).toMatchObject({ status: "failed", attempts: 3 });
  });
});
