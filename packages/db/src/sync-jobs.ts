import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { syncJobs } from "./schema.js";

export type SyncJobRow = typeof syncJobs.$inferSelect;

/**
 * Generic Transactional-Outbox insert against a plain Database handle -- a sibling to
 * product-fetch's own insertOutboxJob (services/lambdas/product-fetch/src/handler.ts), which
 * is scoped to its narrower OutboxTxDb type specifically so it can run inside that file's own
 * Drizzle transaction. Callers that don't need that inner-transaction guarantee (today:
 * admin-api's eBay tracking-upload retry path, created synchronously alongside an order's
 * SHIPPED transition rather than alongside a product_master write) use this one instead, but
 * get the exact same idempotency-keyed insert-or-fetch semantics, backed by sync_jobs' own
 * unique (tenantId, idempotencyKey) index: two overlapping calls with the same key can never
 * create two job rows for the same real-world event.
 */
export async function insertSyncJob(
  db: Database,
  params: { tenantId: string; type: string; idempotencyKey: string; productId: string | null; payload: Record<string, unknown> },
): Promise<SyncJobRow> {
  const [inserted] = await db
    .insert(syncJobs)
    .values({ ...params, status: "pending" })
    .onConflictDoNothing({ target: [syncJobs.tenantId, syncJobs.idempotencyKey] })
    .returning();
  if (inserted) return inserted;

  const [existing] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.tenantId, params.tenantId), eq(syncJobs.idempotencyKey, params.idempotencyKey)))
    .limit(1);
  // Can only be missing if we lost a race with a concurrent DELETE of the row we just
  // conflicted with -- this table is never deleted from, so this is unreachable in practice.
  return existing!;
}

/** Looked up by ebay-sync-worker when it processes a retried ebay_tracking_upload message --
 *  the message itself carries no job id, only tenantId/orderId, so the worker reconstructs the
 *  same deterministic idempotencyKey the admin-api route used to create the job and looks it
 *  up by that, rather than needing the id threaded through every retry payload. */
export async function getSyncJobByIdempotencyKey(db: Database, tenantId: string, idempotencyKey: string): Promise<SyncJobRow | undefined> {
  const [row] = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.tenantId, tenantId), eq(syncJobs.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row;
}

export async function markSyncJobCompleted(db: Database, id: string): Promise<void> {
  await db.update(syncJobs).set({ status: "completed", updatedAt: new Date() }).where(eq(syncJobs.id, id));
}

export async function markSyncJobFailed(db: Database, id: string, attempts: number): Promise<void> {
  await db.update(syncJobs).set({ status: "failed", attempts: attempts + 1, updatedAt: new Date() }).where(eq(syncJobs.id, id));
}
