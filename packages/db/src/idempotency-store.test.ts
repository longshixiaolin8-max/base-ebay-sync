import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { createDbIdempotencyStore } from "./idempotency-store.js";

/**
 * A minimal in-memory stand-in for the idempotency_keys table that implements the exact
 * semantics of the real query: `INSERT ... ON CONFLICT (key) DO UPDATE ... WHERE status =
 * 'failed'`. A conflicting row only gets touched (and only then does .returning() yield a
 * row) when its current status is "failed" — this is what makes two concurrent claims on a
 * fresh or in-progress key resolve to exactly one winner.
 */
class FakeIdempotencyTable {
  rows = new Map<string, { key: string; status: string; result: unknown }>();

  /** Returns the row iff this call's write actually took effect (insert or conditional update). */
  upsert(key: string, status: string, result: unknown): { key: string; status: string; result: unknown } | undefined {
    const existing = this.rows.get(key);
    if (!existing) {
      const row = { key, status, result };
      this.rows.set(key, row);
      return row;
    }
    if (existing.status !== "failed") {
      return undefined; // ON CONFLICT DO UPDATE ... WHERE status = 'failed' does not match
    }
    existing.status = status;
    existing.result = result;
    return existing;
  }
}

function fakeDb(table: FakeIdempotencyTable): Database {
  return {
    insert: () => ({
      values: (values: { key: string; status: string; result: unknown }) => ({
        onConflictDoUpdate: () => ({
          returning: async () => {
            const row = table.upsert(values.key, values.status, values.result);
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
    const store = createDbIdempotencyStore(fakeDb(table));

    const claim = await store.tryClaim("key-1", 3600);
    expect(claim).toBeNull();

    await store.complete("key-1", { ok: true });
    const second = await store.tryClaim("key-1", 3600);
    expect(second).toEqual({ key: "key-1", status: "completed", result: { ok: true } });
  });

  it("never lets two concurrent claims on the same fresh key both win", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table));

    const [claimA, claimB] = await Promise.all([store.tryClaim("sale-order-1", 3600), store.tryClaim("sale-order-1", 3600)]);

    const winners = [claimA, claimB].filter((c) => c === null);
    const losers = [claimA, claimB].filter((c) => c !== null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]?.status).toBe("in_progress");
  });

  it("lets a later claim through once the earlier claim is marked failed", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table));

    await store.tryClaim("key-2", 3600);
    await store.fail("key-2");

    const retryClaim = await store.tryClaim("key-2", 3600);
    expect(retryClaim).toBeNull(); // failed rows are re-claimable
  });

  it("does not let a retry claim a key that is still in_progress", async () => {
    const table = new FakeIdempotencyTable();
    const store = createDbIdempotencyStore(fakeDb(table));

    await store.tryClaim("key-3", 3600);
    const secondAttempt = await store.tryClaim("key-3", 3600);

    expect(secondAttempt?.status).toBe("in_progress");
  });
});
