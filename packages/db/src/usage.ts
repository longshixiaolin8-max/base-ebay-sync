import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { productMaster, usageCounters } from "./schema.js";

const AI_GENERATION_METRIC = "ai_generation";

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Structural subset of Database that a Drizzle transaction callback's `tx` handle also
 *  satisfies -- lets read helpers like countProducts run against either a plain Database
 *  or an in-flight transaction, without a separate overload for each. */
export interface Queryable {
  select: Database["select"];
}

/** Live count, not a monthly counter -- product_master is cheap to count directly and
 *  the quota cares about "how many exist right now", not "how many this month". */
export async function countProducts(db: Queryable, tenantId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productMaster)
    .where(eq(productMaster.tenantId, tenantId));
  return row?.count ?? 0;
}

export async function getMonthlyAiGenerationCount(db: Database, tenantId: string, now: Date = new Date()): Promise<number> {
  const periodStart = startOfMonthUtc(now);
  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, AI_GENERATION_METRIC), eq(usageCounters.periodStart, periodStart)))
    .limit(1);
  return row?.count ?? 0;
}

/**
 * Atomically reserves one unit of this tenant's monthly AI-generation quota, returning
 * true only if the reservation succeeded. A single INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE statement, not a separate "read the count, then decide whether to write" pair --
 * the WHERE guard on the DO UPDATE means Postgres only performs (and RETURNs a row for)
 * the increment when the existing row's count is still under `limit`, so two concurrent
 * reservations for the same tenant can never both succeed past the limit the way a
 * get-count-then-increment pair could (that was a real TOCTOU bug this replaces).
 *
 * Call this BEFORE the slow/external generation call it's gating, and call
 * releaseMonthlyAiGenerationReservation() if that call then fails -- so a failed attempt
 * never permanently consumes quota (this repo's own commercial-readiness review confirmed
 * that "no charge on failure" behavior is required, and this preserves it).
 */
export async function tryReserveMonthlyAiGeneration(
  db: Database,
  tenantId: string,
  limit: number,
  now: Date = new Date(),
): Promise<boolean> {
  const periodStart = startOfMonthUtc(now);
  const rows = await db
    .insert(usageCounters)
    .values({ tenantId, metric: AI_GENERATION_METRIC, periodStart, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.metric, usageCounters.periodStart],
      set: { count: sql`${usageCounters.count} + 1` },
      where: sql`${usageCounters.count} < ${limit}`,
    })
    .returning({ count: usageCounters.count });
  return rows.length > 0;
}

/** Refunds one unit reserved by tryReserveMonthlyAiGeneration when the generation attempt
 *  that followed it failed. Never lets the count go below 0. */
export async function releaseMonthlyAiGenerationReservation(db: Database, tenantId: string, now: Date = new Date()): Promise<void> {
  const periodStart = startOfMonthUtc(now);
  await db
    .update(usageCounters)
    .set({ count: sql`greatest(${usageCounters.count} - 1, 0)` })
    .where(
      and(
        eq(usageCounters.tenantId, tenantId),
        eq(usageCounters.metric, AI_GENERATION_METRIC),
        eq(usageCounters.periodStart, periodStart),
      ),
    );
}
