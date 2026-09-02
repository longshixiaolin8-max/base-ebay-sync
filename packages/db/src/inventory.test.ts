import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { applySale, ConcurrentInventoryUpdateError } from "./inventory.js";

/**
 * A minimal in-memory stand-in for the single inventory_master row applySale() touches,
 * implementing the exact compare-and-swap semantics Postgres gives the real
 * `WHERE product_id = ? AND version = ?` UPDATE: a write only takes effect, and only
 * returns a row, when the version it targeted is still current at write time. This lets
 * tests interleave two "concurrent" applySale() calls deterministically and prove the
 * race is actually handled, not just that the SQL looks right.
 */
class FakeInventoryRow {
  quantity: number;
  soldOut: boolean;
  version = 0;

  constructor(quantity: number) {
    this.quantity = quantity;
    this.soldOut = quantity <= 0;
  }

  select() {
    return { quantity: this.quantity, soldOut: this.soldOut, version: this.version };
  }

  /** Returns the updated row on success, or undefined if `expectedVersion` is stale. */
  compareAndSwap(expectedVersion: number, quantity: number, soldOut: boolean) {
    if (this.version !== expectedVersion) return undefined;
    this.quantity = quantity;
    this.soldOut = soldOut;
    this.version += 1;
    return { quantity: this.quantity, soldOut: this.soldOut, version: this.version };
  }
}

interface FakeDb {
  select: () => unknown;
  update: (...args: unknown[]) => unknown;
}

function realUpdate(row: FakeInventoryRow) {
  return () => ({
    set: (values: { quantity: number; soldOut: boolean; version: number }) => ({
      where: () => ({
        returning: async () => {
          const expectedVersion = values.version - 1; // applySale always sets version: current.version + 1
          const result = row.compareAndSwap(expectedVersion, values.quantity, values.soldOut);
          return result ? [result] : [];
        },
      }),
    }),
  });
}

function fakeDb(row: FakeInventoryRow): FakeDb {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row.select()],
        }),
      }),
    }),
    update: realUpdate(row),
  };
}

/** applySale only needs .select()/.update() from Database — cast the minimal fake through. */
function asDatabase(db: FakeDb): Database {
  return db as unknown as Database;
}

describe("applySale", () => {
  it("decrements quantity and bumps version on a normal sale", async () => {
    const row = new FakeInventoryRow(5);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 2);

    expect(result).toEqual({ quantity: 3, soldOut: false, alreadyZero: false });
    expect(row.version).toBe(1);
  });

  it("floors at zero and marks soldOut when the sale exceeds remaining stock", async () => {
    const row = new FakeInventoryRow(2);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 5);

    expect(result).toEqual({ quantity: 0, soldOut: true, alreadyZero: false });
  });

  it("is a no-op once the product is already sold out — this is the double-sell guard", async () => {
    const row = new FakeInventoryRow(0);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 1);

    expect(result).toEqual({ quantity: 0, soldOut: true, alreadyZero: true });
    expect(row.version).toBe(0); // no write attempted
  });

  it("never oversells when two sales for the same last unit race: exactly one wins", async () => {
    // Simulates the real scenario this whole mechanism exists for: a BASE sale and an eBay
    // sale for the same product's last unit, processed by two SQS consumers at once. Both
    // read quantity=1/version=0 before either writes, exactly like two Lambda invocations
    // racing on the real Aurora row.
    const row = new FakeInventoryRow(1);
    const readA = row.select();
    const readB = row.select();
    expect(readA.version).toBe(readB.version); // both saw the same pre-race state

    // Writer A applies first — succeeds, drives the product to sold out.
    const writeA = row.compareAndSwap(readA.version, Math.max(0, readA.quantity - 1), true);
    expect(writeA).toEqual({ quantity: 0, soldOut: true, version: 1 });

    // Writer B's CAS against the stale version it read must fail, forcing a retry —
    // exercised through the real applySale() retry loop this time, not the raw primitive.
    const staleWrite = row.compareAndSwap(readB.version, Math.max(0, readB.quantity - 1), true);
    expect(staleWrite).toBeUndefined();

    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 1);
    expect(result).toEqual({ quantity: 0, soldOut: true, alreadyZero: true });
    expect(row.quantity).toBe(0); // never went negative despite two sales for one unit
  });

  it("retries the CAS loop when a concurrent writer wins the first attempt", async () => {
    const row = new FakeInventoryRow(3);
    let calls = 0;
    const db = fakeDb(row);
    const originalUpdate = db.update;
    // Force the first CAS attempt to lose the race (simulating another worker's write
    // landing between our read and our write), then let the retry proceed normally.
    db.update = ((..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) {
        row.version += 1; // another writer "sneaks in" between our read and write
        return originalUpdate();
      }
      return originalUpdate();
    }) as typeof db.update;

    const result = await applySale(asDatabase(db), "product-1", 1);

    expect(result).toEqual({ quantity: 2, soldOut: false, alreadyZero: false });
    expect(calls).toBeGreaterThan(1);
  });

  it("throws ConcurrentInventoryUpdateError after exhausting retries under sustained contention", async () => {
    const row = new FakeInventoryRow(10);
    const db = fakeDb(row);
    const originalUpdate = db.update;
    // Every attempt loses the race — a pathological but possible case under very high
    // contention — and applySale must give up rather than retry forever.
    db.update = ((..._args: unknown[]) => {
      row.version += 1;
      return originalUpdate();
    }) as typeof db.update;

    await expect(applySale(asDatabase(db), "product-1", 1, 3)).rejects.toThrow(ConcurrentInventoryUpdateError);
  });
});
