import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { countProducts, getMonthlyAiGenerationCount, incrementMonthlyAiGenerationCount } from "./usage.js";

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
 * count = count + 1`. Lets these tests verify per-tenant/per-month isolation without a
 * real database.
 */
class FakeUsageTable {
  rows = new Map<string, number>();

  key(tenantId: string, metric: string, periodStart: Date): string {
    return `${tenantId}:${metric}:${periodStart.toISOString()}`;
  }

  increment(tenantId: string, metric: string, periodStart: Date): void {
    const k = this.key(tenantId, metric, periodStart);
    this.rows.set(k, (this.rows.get(k) ?? 0) + 1);
  }
}

function fakeDb(table: FakeUsageTable): Database {
  return {
    insert: () => ({
      values: (values: { tenantId: string; metric: string; periodStart: Date }) => ({
        onConflictDoUpdate: async () => {
          table.increment(values.tenantId, values.metric, values.periodStart);
        },
      }),
    }),
  } as unknown as Database;
}

describe("incrementMonthlyAiGenerationCount", () => {
  it("creates the counter at 1 on the first call and increments on subsequent calls", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table);
    const now = new Date("2026-09-15T00:00:00Z");

    await incrementMonthlyAiGenerationCount(db, "tenant-a", now);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);

    await incrementMonthlyAiGenerationCount(db, "tenant-a", now);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(2);
  });

  it("keeps counts isolated per tenant", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table);
    const now = new Date("2026-09-15T00:00:00Z");

    await incrementMonthlyAiGenerationCount(db, "tenant-a", now);
    await incrementMonthlyAiGenerationCount(db, "tenant-b", now);
    await incrementMonthlyAiGenerationCount(db, "tenant-a", now);

    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(2);
    expect(table.rows.get(table.key("tenant-b", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);
  });

  it("keeps counts isolated per calendar month", async () => {
    const table = new FakeUsageTable();
    const db = fakeDb(table);

    await incrementMonthlyAiGenerationCount(db, "tenant-a", new Date("2026-08-31T23:59:00Z"));
    await incrementMonthlyAiGenerationCount(db, "tenant-a", new Date("2026-09-01T00:00:01Z"));

    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 7, 1))))).toBe(1);
    expect(table.rows.get(table.key("tenant-a", "ai_generation", new Date(Date.UTC(2026, 8, 1))))).toBe(1);
  });
});
