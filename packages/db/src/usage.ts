import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { productMaster, usageCounters } from "./schema.js";

const AI_GENERATION_METRIC = "ai_generation";
/** Commercial-launch metric: publish+update calls to eBay, the other metered, real-cost
 *  action besides AI generation -- see ebay-sync-worker's publish()/update(). */
const EBAY_SYNC_METRIC = "ebay_sync";

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getMonthlyUsageCount(db: Database, tenantId: string, metric: string, now: Date): Promise<number> {
  const periodStart = startOfMonthUtc(now);
  const [row] = await db
    .select({ count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, metric), eq(usageCounters.periodStart, periodStart)))
    .limit(1);
  return row?.count ?? 0;
}

/** Shared by every metered action (AI generation, eBay sync, ...): see
 *  tryReserveMonthlyAiGeneration's doc comment for the atomicity rationale -- one INSERT
 *  ... ON CONFLICT DO UPDATE ... WHERE statement, never a separate read-then-write pair. */
async function tryReserveMonthlyUsage(db: Database, tenantId: string, metric: string, limit: number, now: Date): Promise<boolean> {
  const periodStart = startOfMonthUtc(now);
  const rows = await db
    .insert(usageCounters)
    .values({ tenantId, metric, periodStart, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.metric, usageCounters.periodStart],
      set: { count: sql`${usageCounters.count} + 1` },
      where: sql`${usageCounters.count} < ${limit}`,
    })
    .returning({ count: usageCounters.count });
  return rows.length > 0;
}

async function releaseMonthlyUsageReservation(db: Database, tenantId: string, metric: string, now: Date): Promise<void> {
  const periodStart = startOfMonthUtc(now);
  await db
    .update(usageCounters)
    .set({ count: sql`greatest(${usageCounters.count} - 1, 0)` })
    .where(and(eq(usageCounters.tenantId, tenantId), eq(usageCounters.metric, metric), eq(usageCounters.periodStart, periodStart)));
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

/** Same real live count as countProducts, scoped to one product_master.status value -- used
 *  by the products list's KPI row (下書き/売り切れ counts), which needs the true count across
 *  the whole catalog, not just whatever page is currently loaded. */
export async function countProductsByStatus(db: Queryable, tenantId: string, status: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(productMaster)
    .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.status, status)));
  return row?.count ?? 0;
}

export async function getMonthlyAiGenerationCount(db: Database, tenantId: string, now: Date = new Date()): Promise<number> {
  return getMonthlyUsageCount(db, tenantId, AI_GENERATION_METRIC, now);
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
  return tryReserveMonthlyUsage(db, tenantId, AI_GENERATION_METRIC, limit, now);
}

/** Refunds one unit reserved by tryReserveMonthlyAiGeneration when the generation attempt
 *  that followed it failed. Never lets the count go below 0. */
export async function releaseMonthlyAiGenerationReservation(db: Database, tenantId: string, now: Date = new Date()): Promise<void> {
  return releaseMonthlyUsageReservation(db, tenantId, AI_GENERATION_METRIC, now);
}

/** Same atomic reserve/release pattern as AI generation, metered separately so a tenant's
 *  eBay-sync quota and AI-generation quota each run out independently. Call before the
 *  real eBay publish/update API call and release on failure -- see ebay-sync-worker's
 *  publish()/update(). */
export async function getMonthlyEbaySyncCount(db: Database, tenantId: string, now: Date = new Date()): Promise<number> {
  return getMonthlyUsageCount(db, tenantId, EBAY_SYNC_METRIC, now);
}

export async function tryReserveMonthlyEbaySync(db: Database, tenantId: string, limit: number, now: Date = new Date()): Promise<boolean> {
  return tryReserveMonthlyUsage(db, tenantId, EBAY_SYNC_METRIC, limit, now);
}

export async function releaseMonthlyEbaySyncReservation(db: Database, tenantId: string, now: Date = new Date()): Promise<void> {
  return releaseMonthlyUsageReservation(db, tenantId, EBAY_SYNC_METRIC, now);
}
