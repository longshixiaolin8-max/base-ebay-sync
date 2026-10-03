import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { createDbIdempotencyStore } from "./idempotency-store.js";

interface FakeRow {
  key: string;
  status: string;
  result: unknown;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * A minimal in-memory stand-in for the idempotency_keys table that implements the exact
 * semantics of the real query: `INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE status =
 * 'failed' OR (status = 'in_progress' AND expires_at < now)`. A conflicting row only gets
 * touched (and only then does .returning() yield a row) when it is reclaimable under that
 * condition -- this is what makes two concurrent claims on a fresh, in_progress-and-live,
 * or completed key resolve to exactly one winner (or none).
 */
class FakeIdempotencyTable {
  rows = new Map<string, FakeRow>();

  /** Returns the row iff this call's write actually took effect (insert or conditional update). */
  upsert(values: { key: string; status: string; result: unknown; createdAt: Date; expiresAt: Date }): FakeRow | undefined {
    const existing = this.rows.get(values.key);
    if (!existing) {
      const row: FakeRow = { ...values };
      this.rows.set(values.key, row);
      return row;
    }
    const now = values.createdAt; // the real code always sets createdAt: now on every claim attempt
    const reclaimable = existing.status === "failed" || (existing.status === "in_progress" && existing.expiresAt < now);
    if (!reclaimable) {
      return undefined; // ON CONFLICT DO UPDATE ... WHERE ... does not match
    }
    existing.status = values.status;
    existing.result = values.result;
    existing.createdAt = values.createdAt;
    existing.expiresAt = values.expiresAt;
    return existing;
  }
}

function fakeDb(table: FakeIdempotencyTable): Database {
  return {
    insert: () => ({
      values: (values: { key: string; status: string; result: unknown; createdAt: Date; expiresAt: Date }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const row = table.upsert(values);
            return row ? [row] : [];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            // Single-key store in these tests; the query always targets the one key in play.
            const [row] = table.rows.values();
            return row ? [row] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: { status: string; result?: unknown }) => ({
        where: async () => {
          const [row] = table.rows.values();
          if (row) {
            row.status = values.status;
            if ("result" in values) row.result = values.result;
          }
        },
      }),
    }),
  } as unknown as Database;
}

describe("createDbIdempotencyStore", () => {
  it("claims a fresh key (tryClaim returns null) then reports it completed", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    const claim = await store.tryClaim("key-1", 3600);
    expect(claim).toBeNull();

    await store.complete("key-1", { ok: true });
    const second = await store.tryClaim("key-1", 3600);
    expect(second).toEqual({ key: "key-1", status: "completed", result: { ok: true } });
  });

  it("does not let a retry reclaim a key that already completed, even long after its TTL elapsed", async () => {
    const table = new FakeIdempotencyTable();
    // Seed a completed row whose expiresAt is far in the past -- a completed record must
    // never be reclaimed just because its TTL elapsed, or a duplicate delivery arriving
    // late would silently redo already-done work instead of replaying the cached result.
    table.rows.set("key-completed", {
      key: "key-completed",
      status: "completed",
      result: { ok: true },
      createdAt: new Date("2020-01-01T00:00:00Z"),
      expiresAt: new Date("2020-01-01T01:00:00Z"),
    });
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    const claim = await store.tryClaim("key-completed", 3600);

    expect(claim).toEqual({ key: "key-completed", status: "completed", result: { ok: true } });
  });

  it("does not let a retry claim a key that is still in_progress and within its TTL", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    await store.tryClaim("key-3", 3600);
    const secondAttempt = await store.tryClaim("key-3", 3600);

    expect(secondAttempt?.status).toBe("in_progress");
  });

  it("reclaims a key stuck in_progress past its expiresAt (Lambda timeout/crash never called complete/fail)", async () => {
    const table = new FakeIdempotencyTable();
    // Seed a stuck in_progress row whose TTL has already passed.
    table.rows.set("key-stuck", {
      key: "key-stuck",
      status: "in_progress",
      result: null,
      createdAt: new Date("2020-01-01T00:00:00Z"),
      expiresAt: new Date("2020-01-01T00:00:01Z"),
    });
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    const claim = await store.tryClaim("key-stuck", 3600);

    expect(claim).toBeNull(); // reclaimed -- this caller now owns it
    expect(table.rows.get("key-stuck")?.status).toBe("in_progress");
  });

  it("lets a later claim through once the earlier claim is marked failed", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    await store.tryClaim("key-2", 3600);
    await store.fail("key-2");

    const retryClaim = await store.tryClaim("key-2", 3600);
    expect(retryClaim).toBeNull(); // failed rows are re-claimable
  });

  it("never lets two concurrent claims on the same fresh key both win", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table), "tenant-a");

    const [claimA, claimB] = await Promise.all([store.tryClaim("sale-order-1", 3600), store.tryClaim("sale-order-1", 3600)]);

    const winners = [claimA, claimB].filter((c) => c === null);
    const losers = [claimA, claimB].filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.status).toBe("in_progress");
  });
});
