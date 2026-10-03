import type { IdempotencyRecord, IdempotencyStatus, IdempotencyStore } from "@ai-ec/core";
import { and, eq, lt, or } from "drizzle-orm";
import type { Database } from "./client.js";
import { idempotencyKeys } from "./schema.js";

/**
 * Postgres-backed IdempotencyStore. Claiming is a single conditional UPSERT so two
 * concurrent Lambda invocations (e.g. duplicate SQS delivery) can never both win the
 * claim — exactly one INSERT/UPDATE returns a row, the other observes the existing one.
 *
 * `key` itself stays the sole primary key (see buildIdempotencyKey in packages/core, which
 * folds tenantId into the key string) -- tenantId here is only for the `tenant_id` column's
 * filtering/observability value, not for uniqueness.
 */
export function createDbIdempotencyStore(db: Database, tenantId: string): IdempotencyStore {
  async function tryClaim(key: string, ttlSeconds: number): Promise<IdempotencyRecord | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const claimed = await db
      .insert(idempotencyKeys)
      .values({ key, tenantId, status: "in_progress", result: null, createdAt: now, expiresAt })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: { status: "in_progress", result: null, createdAt: now, expiresAt },
        // Reclaim a row that previously failed, OR one still marked "in_progress" whose
        // expiresAt has already passed -- the latter means the worker that claimed it
        // (Lambda timeout, crash, killed container) never called complete()/fail(), so
        // without this the key would stay locked forever with no way to ever retry it.
        // Deliberately scoped to status = "in_progress" (not just expiresAt < now): a
        // "completed" row must never be reclaimed just because its TTL elapsed, or a
        // duplicate delivery arriving after that TTL would silently redo already-done work
        // instead of replaying the cached result -- expiry only ever frees a stuck claim,
        // never a finished one.
        where: or(eq(idempotencyKeys.status, "failed"), and(eq(idempotencyKeys.status, "in_progress"), lt(idempotencyKeys.expiresAt, now))),
      })
      .returning();

    if (claimed.length > 0) {
      return null;
    }

    const [existing] = await db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    if (!existing) {
      // Lost a race with a concurrent fail()+delete or first-ever insert; safe to retry once.
      return tryClaim(key, ttlSeconds);
    }

    return {
      key: existing.key,
      status: existing.status as IdempotencyStatus,
      result: existing.result,
    };
  }

  return {
    tryClaim,
    async complete(key, result) {
      await db
        .update(idempotencyKeys)
        .set({ status: "completed", result: result as object })
        .where(eq(idempotencyKeys.key, key));
    },
    async fail(key) {
      await db.update(idempotencyKeys).set({ status: "failed" }).where(eq(idempotencyKeys.key, key));
    },
  };
}
