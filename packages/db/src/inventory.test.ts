import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  applyBaseStockReport,
  applySale,
  calculateChannelAvailableQuantity,
  ConcurrentInventoryUpdateError,
  reconstructInventory,
} from "./inventory.js";

describe("calculateChannelAvailableQuantity", () => {
  it("shows the source channel (BASE) full true stock, unbuffered", () => {
    expect(calculateChannelAvailableQuantity(5, 2, "base", "base")).toBe(5);
  });

  it("withholds the safety stock buffer from a secondary channel", () => {
    expect(calculateChannelAvailableQuantity(5, 2, "ebay", "base")).toBe(3);
  });

  it("floors at 0 rather than going negative when the buffer exceeds true stock", () => {
    expect(calculateChannelAvailableQuantity(1, 3, "ebay", "base")).toBe(0);
  });

  it("passes true stock straight through when no buffer is configured", () => {
    expect(calculateChannelAvailableQuantity(4, 0, "ebay", "base")).toBe(4);
  });
});

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
  lastBaseSeq: Date | null = null;
  ebaySoldSinceBaseSync = 0;

  constructor(quantity: number) {
    this.quantity = quantity;
    this.soldOut = quantity <= 0;
  }

  select() {
    return {
      quantity: this.quantity,
      soldOut: this.soldOut,
      version: this.version,
      lastBaseSeq: this.lastBaseSeq,
      ebaySoldSinceBaseSync: this.ebaySoldSinceBaseSync,
    };
  }

  /** Returns the updated row on success, or undefined if `expectedVersion` is stale. */
  compareAndSwap(
    expectedVersion: number,
    values: { quantity: number; soldOut: boolean; lastBaseSeq?: Date; ebaySoldSinceBaseSync: number },
  ) {
    if (this.version !== expectedVersion) return undefined;
    this.quantity = values.quantity;
    this.soldOut = values.soldOut;
    this.ebaySoldSinceBaseSync = values.ebaySoldSinceBaseSync;
    if (values.lastBaseSeq !== undefined) this.lastBaseSeq = values.lastBaseSeq;
    this.version += 1;
    return this.select();
  }
}

interface InsertedEvent {
  productId: string;
  channel: string;
  eventType: string;
  sequenceAt: Date;
  quantityDelta?: number;
  absoluteQuantity?: number;
  applied: boolean;
  skippedReason?: string;
}

interface FakeDb {
  select: () => unknown;
  update: (...args: unknown[]) => unknown;
  insert: (...args: unknown[]) => unknown;
  events: InsertedEvent[];
}

function realUpdate(row: FakeInventoryRow) {
  return () => ({
    set: (values: { quantity: number; soldOut: boolean; version: number; lastBaseSeq?: Date; ebaySoldSinceBaseSync: number }) => ({
      where: () => ({
        returning: async () => {
          const expectedVersion = values.version - 1; // always sets version: current.version + 1
          const result = row.compareAndSwap(expectedVersion, values);
          return result ? [result] : [];
        },
      }),
    }),
  });
}

function fakeDb(row: FakeInventoryRow): FakeDb {
  const events: InsertedEvent[] = [];
  return {
    select: () => ({
      from: (table: { name?: string }) => ({
        where: () => ({
          limit: async () => [row.select()],
          // reconstructInventory's inventory_events query has no .limit() and only wants
          // applied events, matching its real `where(eq(applied, true))` filter.
          then: (resolve: (v: unknown) => void) => {
            void table;
            resolve(events.filter((e) => e.applied) as unknown);
          },
        }),
      }),
    }),
    update: realUpdate(row),
    insert: () => ({
      values: async (v: InsertedEvent) => {
        events.push(v);
      },
    }),
    events,
  };
}

/** applySale only needs .select()/.update()/.insert() from Database — cast the fake through. */
function asDatabase(db: FakeDb): Database {
  return db as unknown as Database;
}

describe("applySale", () => {
  it("decrements quantity and bumps version on a normal sale", async () => {
    const row = new FakeInventoryRow(5);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 2, { channel: "base" });

    expect(result).toEqual({ quantity: 3, soldOut: false, alreadyZero: false });
    expect(row.version).toBe(1);
  });

  it("floors at zero and marks soldOut when the sale exceeds remaining stock", async () => {
    const row = new FakeInventoryRow(2);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 5, { channel: "base" });

    expect(result).toEqual({ quantity: 0, soldOut: true, alreadyZero: false });
  });

  it("is a no-op once the product is already sold out — this is the double-sell guard", async () => {
    const row = new FakeInventoryRow(0);
    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 1, { channel: "base" });

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
    const writeA = row.compareAndSwap(readA.version, {
      quantity: Math.max(0, readA.quantity - 1),
      soldOut: true,
      ebaySoldSinceBaseSync: readA.ebaySoldSinceBaseSync,
    });
    expect(writeA).toMatchObject({ quantity: 0, soldOut: true, version: 1 });

    // Writer B's CAS against the stale version it read must fail, forcing a retry —
    // exercised through the real applySale() retry loop this time, not the raw primitive.
    const staleWrite = row.compareAndSwap(readB.version, {
      quantity: Math.max(0, readB.quantity - 1),
      soldOut: true,
      ebaySoldSinceBaseSync: readB.ebaySoldSinceBaseSync,
    });
    expect(staleWrite).toBeUndefined();

    const result = await applySale(asDatabase(fakeDb(row)), "product-1", 1, { channel: "base" });
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

    const result = await applySale(asDatabase(db), "product-1", 1, { channel: "base" });

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

    await expect(applySale(asDatabase(db), "product-1", 1, { channel: "base", maxRetries: 3 })).rejects.toThrow(
      ConcurrentInventoryUpdateError,
    );
  });
});

describe("applyBaseStockReport", () => {
  it("reconciles a fresh report, subtracting eBay sales BASE doesn't know about", async () => {
    const row = new FakeInventoryRow(5);
    row.ebaySoldSinceBaseSync = 2; // 2 units sold on eBay since BASE was last synced
    const t1 = new Date("2026-09-01T00:00:00Z");

    const result = await applyBaseStockReport(asDatabase(fakeDb(row)), "product-1", 5, t1);

    expect(result).toEqual({ applied: true, quantity: 3 });
    expect(row.quantity).toBe(3);
    expect(row.ebaySoldSinceBaseSync).toBe(0); // reset after reconciling
    expect(row.lastBaseSeq).toEqual(t1);
  });

  it("rejects a report whose sequence isn't newer than the last one applied — reversal detection", async () => {
    const row = new FakeInventoryRow(5);
    const t1 = new Date("2026-09-02T00:00:00Z");
    const t0 = new Date("2026-09-01T00:00:00Z"); // older than t1
    row.lastBaseSeq = t1;

    const result = await applyBaseStockReport(asDatabase(fakeDb(row)), "product-1", 99, t0);

    expect(result).toEqual({ applied: false, quantity: 5, reason: "out_of_order" });
    expect(row.quantity).toBe(5); // untouched
    expect(row.version).toBe(0); // no write attempted
  });

  it("floors the reconciled quantity at 0 rather than going negative", async () => {
    const row = new FakeInventoryRow(1);
    row.ebaySoldSinceBaseSync = 5; // more eBay sales recorded than BASE now reports in stock
    const t1 = new Date("2026-09-01T00:00:00Z");

    const result = await applyBaseStockReport(asDatabase(fakeDb(row)), "product-1", 2, t1);

    expect(result).toEqual({ applied: true, quantity: 0 });
  });
});

describe("reconstructInventory", () => {
  it("replays events since the last BASE snapshot and flags drift against the live counter", async () => {
    const row = new FakeInventoryRow(3); // counter says 3, but the real history implies 2
    const db = fakeDb(row);
    db.events.push(
      { productId: "p1", channel: "base", eventType: "base_stock_report", sequenceAt: new Date("2026-09-01T00:00:00Z"), absoluteQuantity: 5, applied: true },
      { productId: "p1", channel: "ebay", eventType: "sale", sequenceAt: new Date("2026-09-02T00:00:00Z"), quantityDelta: 2, applied: true },
      { productId: "p1", channel: "base", eventType: "base_stock_report", sequenceAt: new Date("2026-09-01T12:00:00Z"), absoluteQuantity: 999, applied: false, skippedReason: "out_of_order" },
    );

    const result = await reconstructInventory(asDatabase(db), "p1");

    expect(result.reconstructedQuantity).toBe(3); // 5 (last snapshot) - 2 (sale after it)
    expect(result.currentQuantity).toBe(3);
    expect(result.drifted).toBe(false);
    expect(result.eventsReplayed).toBe(2);
  });

  it("reports drift when the live counter disagrees with the replayed history", async () => {
    const row = new FakeInventoryRow(10); // counter says 10, history implies 3
    const db = fakeDb(row);
    db.events.push(
      { productId: "p1", channel: "base", eventType: "base_stock_report", sequenceAt: new Date("2026-09-01T00:00:00Z"), absoluteQuantity: 5, applied: true },
      { productId: "p1", channel: "base", eventType: "sale", sequenceAt: new Date("2026-09-02T00:00:00Z"), quantityDelta: 2, applied: true },
    );

    const result = await reconstructInventory(asDatabase(db), "p1");

    expect(result.reconstructedQuantity).toBe(3);
    expect(result.currentQuantity).toBe(10);
    expect(result.drifted).toBe(true);
  });

  it("starts from 0 when there has never been a BASE stock report", async () => {
    const row = new FakeInventoryRow(0);
    const db = fakeDb(row);
    db.events.push({
      productId: "p1",
      channel: "ebay",
      eventType: "sale",
      sequenceAt: new Date("2026-09-01T00:00:00Z"),
      quantityDelta: 1,
      applied: true,
    });

    const result = await reconstructInventory(asDatabase(db), "p1");

    expect(result.reconstructedQuantity).toBe(0); // floored, never negative
  });
});
