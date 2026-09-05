import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { traceSyncHistory } from "./sync-trace.js";

/** traceSyncHistory() issues 3 queries via Promise.all in this order: inventory_events,
 *  audit_log, sync_errors. */
function fakeDb(fixtures: { events?: unknown[]; auditRows?: unknown[]; errorRows?: unknown[] }): Database {
  const sequence = [fixtures.events ?? [], fixtures.auditRows ?? [], fixtures.errorRows ?? []];
  let call = 0;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => sequence[call++] ?? [],
          }),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("traceSyncHistory", () => {
  it("returns an empty trace for a product with no history at all", async () => {
    const result = await traceSyncHistory(fakeDb({}), "p1");

    expect(result.entries).toEqual([]);
  });

  it("summarizes an applied sale event", async () => {
    const result = await traceSyncHistory(
      fakeDb({
        events: [
          {
            channel: "ebay",
            eventType: "sale",
            sequenceAt: new Date("2026-09-05T10:00:00Z"),
            quantityDelta: 1,
            absoluteQuantity: null,
            applied: true,
            skippedReason: null,
            externalEventId: "order-1",
          },
        ],
      }),
      "p1",
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.source).toBe("inventory_event");
    expect(result.entries[0]!.summary).toBe("ebay sale: -1 units [applied]");
  });

  it("summarizes a skipped (out-of-order) BASE stock report", async () => {
    const result = await traceSyncHistory(
      fakeDb({
        events: [
          {
            channel: "base",
            eventType: "base_stock_report",
            sequenceAt: new Date("2026-09-05T10:00:00Z"),
            quantityDelta: null,
            absoluteQuantity: 3,
            applied: false,
            skippedReason: "out_of_order",
            externalEventId: null,
          },
        ],
      }),
      "p1",
    );

    expect(result.entries[0]!.summary).toBe("base stock report: quantity=3 [skipped (out_of_order)]");
  });

  it("merges inventory events, audit log entries, and sync errors into one chronological timeline", async () => {
    const result = await traceSyncHistory(
      fakeDb({
        events: [
          {
            channel: "ebay",
            eventType: "sale",
            sequenceAt: new Date("2026-09-05T10:00:00Z"),
            quantityDelta: 1,
            absoluteQuantity: null,
            applied: true,
            skippedReason: null,
            externalEventId: "order-1",
          },
        ],
        auditRows: [
          {
            actor: "system:inventory-sync-worker",
            action: "inventory_immediate_sync_after_sale",
            createdAt: new Date("2026-09-05T10:00:01Z"),
            before: null,
            after: { pushedQuantity: 2 },
          },
        ],
        errorRows: [
          {
            channel: "ebay",
            errorCode: "ebay_update_failed",
            errorMessage: "eBay API error 500: boom",
            createdAt: new Date("2026-09-05T09:59:00Z"),
            payload: null,
          },
        ],
      }),
      "p1",
    );

    expect(result.entries).toHaveLength(3);
    // Newest first.
    expect(result.entries[0]!.source).toBe("audit_log");
    expect(result.entries[1]!.source).toBe("inventory_event");
    expect(result.entries[2]!.source).toBe("sync_error");
    expect(result.entries[2]!.summary).toBe("ebay ebay_update_failed: eBay API error 500: boom");
  });
});
