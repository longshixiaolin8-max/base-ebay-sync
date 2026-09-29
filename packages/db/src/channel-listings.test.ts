import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { countChannelListingsByStatus } from "./channel-listings.js";

describe("countChannelListingsByStatus", () => {
  it("returns the live channel_listings row count for this tenant/channel/status", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{ count: 5 }],
        }),
      }),
    } as unknown as Database;

    expect(await countChannelListingsByStatus(db, "tenant-a", "ebay", "published")).toBe(5);
  });

  it("returns 0 when the query yields no row", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    } as unknown as Database;

    expect(await countChannelListingsByStatus(db, "tenant-a", "ebay", "error")).toBe(0);
  });
});
