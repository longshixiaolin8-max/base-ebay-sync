import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { claimWebhookEvent } from "./webhook-events.js";

describe("claimWebhookEvent", () => {
  it("returns true and inserts a row for a new (source, id) pair", async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted = v;
          return {
            onConflictDoNothing: () => ({
              returning: async () => [{ id: v.id }],
            }),
          };
        },
      }),
    } as unknown as Database;

    const claimed = await claimWebhookEvent(db, "stripe", "evt_123");

    expect(claimed).toBe(true);
    expect(inserted).toEqual({ id: "stripe:evt_123", source: "stripe" });
  });

  it("returns false when the event was already claimed (conflict, nothing returned)", async () => {
    const db = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: async () => [],
          }),
        }),
      }),
    } as unknown as Database;

    expect(await claimWebhookEvent(db, "stripe", "evt_123")).toBe(false);
  });
});
