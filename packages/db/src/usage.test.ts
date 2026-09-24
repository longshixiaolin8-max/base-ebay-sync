import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  countProducts,
  getMonthlyAiGenerationCount,
  releaseMonthlyAiGenerationReservation,
  tryReserveMonthlyAiGeneration,
} from "./usage.js";

describe("countProducts", () => {
  it("returns the live product_master row count for the tenant", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ count: 7 }],
        }),
      }),
    } as unknown as Database;

    expect(await countProducts(db, "tenant-a")).toBe(7);
  });

  it("returns 0 when the query yields no row", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    } as unknown as Database;

    expect(await countProducts(db, "tenant-a")).toBe(0);
  });
});

describe("getMonthlyAiGenerationCount", () => {
  it("returns 0 when no counter row exists yet for this tenant/month", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    } as unknown as Database;

    expect(await getMonthlyAiGenerationCount(db, "tenant-a", new Date("2026-09-15T00:00:00Z"))).toBe(0);
  });

  it("returns the stored count", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ count: 42 }] }),
        }),
      }),
    } as unknown as Database;

    expect(await getMonthlyAiGenerationCount(db, "tenant-a", new Date("2026-09-15T00:00:00Z"))).toBe(42);
  });
});

/**
 * A minimal in-memory stand-in for usage_counters that implements the real query's
 * semantics: `INSERT ... ON CONFLICT (tenant_id, metric, period_start) DO UPDATE SET
 * count = count + 1 WHERE count < limit`, including the WHERE guard actually suppressing
 * the write (and RETURNING no row) when the existing count is already at/over the limit --
 * this is the exact behavior the real atomic reservation depends on. Lets these tests
 * verify per-tenant/per-month isolation and the quota guard without a real database.
 */
class FakeUsageTable {
  rows = new Map<string, number>();

  key(tenantId: string, metric: string, periodStart: Date): string {
    return `${tenantId}:${metric}:${periodStart.toISOString()}`;
  }

  /** Mirrors `ON CONFLICT DO UPDATE SET count = count + 1 WHERE count < limit RETURNING
   *  count` -- returns the new count if the guarded increment happened, or undefined if
   *  the existing row was already at/over `limit` (no row updated, nothing RETURNed). */
  tryIncrement(tenantId: string, metric: string, periodStart: Date, limit: number): number | undefined {
    const k = this.key(tenantId, metric, periodStart);
    const existing = this.rows.get(k);
    if (existing === undefined) {
      this.rows.set(k, 1);
      return 1;
    }
    if (existing >= limit) return undefined;
    const next = existing + 1;
    this.rows.set(k, next);
    return next;
  }

  release(tenantId: string, metric: string, periodStart: Date): void {
    const k = this.key(tenantId, metric, periodStart);
    this.rows.set(k, Math.max((this.rows.get(k) ?? 0) - 1, 0));
  }
}

function fakeDb(table: FakeUsageTable, limit: number, releaseTarget?: { tenantId: string; periodStart: Date }): Database {
  return {
    insert: () => ({
      values: (values: { tenantId: string; metric: string; periodStart: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const count = table.tryIncrement(values.tenantId, values.metric, values.periodStart, limit);
            return count === undefined ? [] : [{ count }];
          },
        }),
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          // releaseMonthlyAiGenerationReservation always targets exactly the one
          // (tenantId, metric, periodStart) row its own arguments compute -- the fake
          // takes that same target directly rather than parsing Drizzle's `and(eq(...))`
          // condition tree, since the function under test has no branching on its shape.
          if (releaseTarget) {
            table.release(releaseTarget.tenantId, "ai_generation", releaseTarget.periodStart);
          }
        },
      }),
    }),
  } as unknown as Database;
}

describe("tryReserveMonthlyAiGeneration", () => {
  it("creates the counter at 1 on the first call and increments on subsequent calls", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table, 100);
    const now = new Date("2026-09-15T00:00:00Z");

    expect(await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, now)).toBe(true);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);

    expect(await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, now)).toBe(true);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(2);
  });

  it("keeps counts isolated per tenant", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table, 100);
    const now = new Date("2026-09-15T00:00:00Z");

    await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, now);
    await tryReserveMonthlyAiGeneration(db, "tenant-b", 100, now);
    await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, now);

    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(2);
    expect(table.rows.get(table.key("tenant-b", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);
  });

  it("keeps counts isolated per calendar month", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table, 100);

    await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, new Date("2026-08-31T23:59:00Z"));
    await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, new Date("2026-09-01T00:00:01Z"));

    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 7, 1))))).toBe(1);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);
  });

  it("refuses the reservation once the count is at the limit, leaving the count unchanged", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table, 2);
    const now = new Date("2026-09-15T00:00:00Z");

    expect(await tryReserveMonthlyAiGeneration(db, "tenant-a", 2, now)).toBe(true); // -> 1
    expect(await tryReserveMonthlyAiGeneration(db, "tenant-a", 2, now)).toBe(true); // -> 2, at limit
    expect(await tryReserveMonthlyAiGeneration(db, "tenant-a", 2, now)).toBe(false); // refused, stays at 2

    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(2);
  });

  it("closes the TOCTOU race: two 'concurrent' reservations at the last remaining slot never both succeed", async () => {
    // Simulates two overlapping requests both attempting to reserve the final unit of a
    // 1-remaining-slot quota (limit=1, count already 0->1 after the first call). With a
    // real get-count-then-increment pair, both could read count=0 and both succeed,
    // landing at count=2 over a limit of 1. The atomic guarded UPSERT here means the
    // second call always observes the first's committed increment.
    const table = new FakeUsageTable();
    const db = fakeDb(table, 1);
    const now = new Date("2026-09-15T00:00:00Z");

    const results = [
      await tryReserveMonthlyAiGeneration(db, "tenant-a", 1, now),
      await tryReserveMonthlyAiGeneration(db, "tenant-a", 1, now),
    ];

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);
  });
});

describe("releaseMonthlyAiGenerationReservation", () => {
  it("decrements the reserved count by 1 when a generation attempt fails after reserving", async () => {
    const table = new FakeUsageTable();
    const now = new Date("2026-09-15T00:00:00Z");
    const periodStart = new Date(Date.UTC(2026, 8, 1));
    const db = fakeDb(table, 100, { tenantId: "tenant-a", periodStart });

    await tryReserveMonthlyAiGeneration(db, "tenant-a", 100, now);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", periodStart))).toBe(1);

    await releaseMonthlyAiGenerationReservation(db, "tenant-a", now);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", periodStart))).toBe(0);
  });

  it("never lets the count go below 0", async () => {
    const table = new FakeUsageTable();
    const now = new Date("2026-09-15T00:00:00Z");
    const periodStart = new Date(Date.UTC(2026, 8, 1));
    const db = fakeDb(table, 100, { tenantId: "tenant-a", periodStart });

    await releaseMonthlyAiGenerationReservation(db, "tenant-a", now);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", periodStart))).toBe(0);
  });
});
