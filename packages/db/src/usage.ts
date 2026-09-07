import { and, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { productMaster, usageCounters } from "./schema.js";

const AI_GENERATION_METRIC = "ai_generation";

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Live count, not a monthly counter -- product_master is cheap to count directly and
 *  the quota cares about "how many exist right now", not "how many this month". */
export async function countProducts(db: Database, tenantId: string): Promise<number> {
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
 * Atomic upsert (no read-modify-write race) -- two concurrent AI generations for the
 * same tenant in the same month both land on the same row and both increments count.
 */
export async function incrementMonthlyAiGenerationCount(db: Database, tenantId: string, now: Date = new Date()): Promise<void> {
  const periodStart = startOfMonthUtc(now);
  await db
    .insert(usageCounters)
    .values({ tenantId, metric: AI_GENERATION_METRIC, periodStart, count: 1 })
    .onConflictDoUpdate({
      target: [usageCounters.tenantId, usageCounters.metric, usageCounters.periodStart],
      set: { count: sql`${usageCounters.count} + 1` },
    });
}
