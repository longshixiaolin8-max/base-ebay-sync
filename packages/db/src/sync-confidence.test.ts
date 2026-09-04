import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { computeSyncConfidence } from "./sync-confidence.js";

function fakeDb(rows: { syncErrors?: unknown[]; channelListings?: unknown[]; inventoryEvents?: unknown[] }): Database {
  const tables = {
    syncErrors: rows.syncErrors ?? [],
    channelListings: rows.channelListings ?? [],
    inventoryEvents: rows.inventoryEvents ?? [],
  };
  let call = 0;
  // computeSyncConfidence always queries in this fixed order: syncErrors, channelListings, inventoryEvents.
  const order: Array<keyof typeof tables> = ["syncErrors", "channelListings", "inventoryEvents"];
  return {
    select: () => ({
      from: () => ({
        where: async () => {
          const key = order[call % order.length]!;
          call += 1;
          return tables[key];
        },
      }),
    }),
  } as unknown as Database;
}

describe("computeSyncConfidence", () => {
  it("scores 100 with no recent activity — absence of evidence isn't evidence of a problem", async () => {
    const db = fakeDb({});
    const result = await computeSyncConfidence(db, "ebay");

    expect(result.score).toBe(100);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
  });

  it("scores 100 when every recent attempt succeeded and every event applied cleanly", async () => {
    const db = fakeDb({
      syncErrors: [],
      channelListings: [{ id: "1" }, { id: "2" }],
      inventoryEvents: [{ applied: true }, { applied: true }],
    });
    const result = await computeSyncConfidence(db, "ebay");

    expect(result.score).toBe(100);
  });

  it("scores low when every recent attempt failed", async () => {
    const db = fakeDb({
      syncErrors: [{ id: "e1" }, { id: "e2" }, { id: "e3" }],
      channelListings: [],
      inventoryEvents: [],
    });
    const result = await computeSyncConfidence(db, "ebay");

    expect(result.score).toBe(0);
    expect(result.failureCount).toBe(3);
  });

  it("averages the error-rate and reversal-rate components", async () => {
    // 2 successes / 2 failures -> errorScore 50; 3 applied / 4 events -> orderScore 75
    const db = fakeDb({
      syncErrors: [{ id: "e1" }, { id: "e2" }],
      channelListings: [{ id: "1" }, { id: "2" }],
      inventoryEvents: [{ applied: true }, { applied: true }, { applied: true }, { applied: false }],
    });
    const result = await computeSyncConfidence(db, "base");

    expect(result.score).toBe(63); // round((50 + 75) / 2)
    expect(result.outOfOrderEventCount).toBe(1);
    expect(result.totalEventCount).toBe(4);
  });

  it("does not let ordinary 'nothing changed' BASE polls count against the reversal rate", async () => {
    // Confirmed live: a product polled twice with no real BASE change in between produced
    // a skippedReason:"unchanged" event every time -- that must not read as sync trouble.
    const db = fakeDb({
      inventoryEvents: [
        { applied: true },
        { applied: false, skippedReason: "unchanged" },
        { applied: false, skippedReason: "unchanged" },
      ],
    });
    const result = await computeSyncConfidence(db, "base");

    expect(result.totalEventCount).toBe(1);
    expect(result.outOfOrderEventCount).toBe(0);
    expect(result.score).toBe(100);
  });
});
