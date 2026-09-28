import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { claimWebhookEvent, completeWebhookEvent, failWebhookEvent, STUCK_PROCESSING_THRESHOLD_MS } from "./webhook-events.js";

interface FakeRow {
  id: string;
  source: string;
  status: string;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

/** A minimal in-memory stand-in for processed_webhook_events, implementing the same
 *  conditional-upsert semantics the real `INSERT ... ON CONFLICT ... WHERE` gives Postgres:
 *  a conflicting row is only updated (and only then returned) when its current status
 *  satisfies the WHERE (failed, or processing past the staleness threshold). */
function fakeDb(existing?: FakeRow) {
  let row: FakeRow | undefined = existing;
  let concurrentClaimCount = 0;

  const db = {
    insert: () => ({
      values: (v: { id: string; source: string; status: string; attempts: number; lastError: string | null; updatedAt: Date }) => ({
        // `v.updatedAt` is always the caller's `now` (claimWebhookEvent passes the same
        // value whether this ends up being a fresh insert or a conflict) -- reimplementing
        // the same reclaim predicate the real `WHERE status = 'failed' OR (status =
        // 'processing' AND updated_at < staleBefore)` clause encodes from it, rather than
        // trying to interpret drizzle's expression-tree object directly.
        onConflictDoUpdate: () => ({
          returning: async () => {
            if (!row) {
              row = { ...v };
              return [{ id: row.id }];
            }
            const staleBefore = new Date(v.updatedAt.getTime() - STUCK_PROCESSING_THRESHOLD_MS);
            const reclaimable = row.status === "failed" || (row.status === "processing" && row.updatedAt < staleBefore);
            if (!reclaimable) {
              concurrentClaimCount += 1;
              return [];
            }
            row = { ...row, status: "processing", attempts: row.attempts + 1, lastError: null, updatedAt: v.updatedAt };
            return [{ id: row.id }];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [{ status: row.status }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (v: { status: string; lastError: string | null; updatedAt: Date }) => ({
        where: async () => {
          if (row) row = { ...row, ...v };
        },
      }),
    }),
  };
  return { db: db as unknown as Database, getRow: () => row, getConcurrentClaimCount: () => concurrentClaimCount };
}

const SOURCE = "stripe";
const EVENT_ID = "evt_123";

describe("claimWebhookEvent", () => {
  it("claims a brand new (source, id) pair", async () => {
    const { db, getRow } = fakeDb();
    const now = new Date("2026-09-01T00:00:00Z");

    const result = await claimWebhookEvent(db, SOURCE, EVENT_ID, now);

    expect(result).toEqual({ claimed: true });
    expect(getRow()).toMatchObject({ id: "stripe:evt_123", status: "processing", attempts: 1 });
  });

  it("does not claim (reports status 'completed') an already-completed event -- a true duplicate", async () => {
    const { db } = fakeDb({
      id: "stripe:evt_123",
      source: SOURCE,
      status: "completed",
      attempts: 1,
      lastError: null,
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });

    const result = await claimWebhookEvent(db, SOURCE, EVENT_ID, new Date("2026-09-01T00:05:00Z"));

    expect(result).toEqual({ claimed: false, status: "completed" });
  });

  it("does not claim an event still within its 'processing' staleness window", async () => {
    const claimedAt = new Date("2026-09-01T00:00:00Z");
    const { db } = fakeDb({ id: "stripe:evt_123", source: SOURCE, status: "processing", attempts: 1, lastError: null, updatedAt: claimedAt });

    // Only 1 minute later -- well within the staleness threshold.
    const result = await claimWebhookEvent(db, SOURCE, EVENT_ID, new Date(claimedAt.getTime() + 60 * 1000));

    expect(result).toEqual({ claimed: false, status: "processing" });
  });

  it("reclaims a 'processing' event that has been stuck past the staleness threshold (Lambda timeout/crash)", async () => {
    const claimedAt = new Date("2026-09-01T00:00:00Z");
    const { db, getRow } = fakeDb({ id: "stripe:evt_123", source: SOURCE, status: "processing", attempts: 1, lastError: null, updatedAt: claimedAt });

    // 15 minutes later -- past the 10-minute staleness threshold.
    const result = await claimWebhookEvent(db, SOURCE, EVENT_ID, new Date(claimedAt.getTime() + 15 * 60 * 1000));

    expect(result).toEqual({ claimed: true });
    expect(getRow()).toMatchObject({ status: "processing", attempts: 2 });
  });

  it("reclaims a 'failed' event regardless of how recently it failed", async () => {
    const { db, getRow } = fakeDb({
      id: "stripe:evt_123",
      source: SOURCE,
      status: "failed",
      attempts: 1,
      lastError: "connection reset",
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    });

    const result = await claimWebhookEvent(db, SOURCE, EVENT_ID, new Date("2026-09-01T00:00:05Z"));

    expect(result).toEqual({ claimed: true });
    expect(getRow()).toMatchObject({ status: "processing", attempts: 2, lastError: null });
  });

  it("lets only one of two concurrent claim attempts succeed for the same event", async () => {
    const { db, getConcurrentClaimCount } = fakeDb();
    const now = new Date("2026-09-01T00:00:00Z");

    const [first, second] = await Promise.all([claimWebhookEvent(db, SOURCE, EVENT_ID, now), claimWebhookEvent(db, SOURCE, EVENT_ID, now)]);

    const claims = [first, second].filter((r) => r.claimed);
    expect(claims).toHaveLength(1);
    // The fake's own concurrentClaimCount tracks how many upsert attempts saw an
    // already-non-reclaimable row and returned nothing, mirroring what Postgres' real
    // WHERE-conditional upsert guarantees: a second conflicting writer never overwrites
    // the first's claim.
    expect(getConcurrentClaimCount()).toBe(1);
  });
});

describe("completeWebhookEvent / failWebhookEvent", () => {
  it("marks a claimed event completed", async () => {
    const { db, getRow } = fakeDb({ id: "stripe:evt_123", source: SOURCE, status: "processing", attempts: 1, lastError: null, updatedAt: new Date() });

    await completeWebhookEvent(db, SOURCE, EVENT_ID, new Date("2026-09-01T00:01:00Z"));

    expect(getRow()).toMatchObject({ status: "completed", lastError: null });
  });

  it("marks a claimed event failed with the error message, making it reclaimable", async () => {
    const { db, getRow } = fakeDb({ id: "stripe:evt_123", source: SOURCE, status: "processing", attempts: 1, lastError: null, updatedAt: new Date() });

    await failWebhookEvent(db, SOURCE, EVENT_ID, "connection reset", new Date("2026-09-01T00:01:00Z"));

    expect(getRow()).toMatchObject({ status: "failed", lastError: "connection reset" });
  });
});
