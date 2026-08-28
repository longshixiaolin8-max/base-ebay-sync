import type { IdempotencyRecord, IdempotencyStatus, IdempotencyStore } from "@ai-ec/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { idempotencyKeys } from "./schema.js";

/**
 * Postgres-backed IdempotencyStore. Claiming is a single conditional UPSERT so two
 * concurrent Lambda invocations (e.g. duplicate SQS delivery) can never both win the
 * claim — exactly one INSERT/UPDATE returns a row, the other observes the existing one.
 */
export function createDbIdempotencyStore(db: Database): IdempotencyStore {
  async function tryClaim(key: string, ttlSeconds: number): Promise<IdempotencyRecord | null> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const claimed = await db
      .insert(idempotencyKeys)
      .values({ key, status: "in_progress", result: null, createdAt: now, expiresAt })
      .onConflictDoUpdate({
        target: idempotencyKeys.key,
        set: { status: "in_progress", result: null, createdAt: now, expiresAt },
        // Only re-claim a row that previously failed; a completed/in-progress row is
        // left untouched — this WHERE is what makes the upsert conditional.
        where: eq(idempotencyKeys.status, "failed"),
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
