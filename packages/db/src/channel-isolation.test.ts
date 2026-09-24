import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./client.js";

const shouldThrottleChannelMock = vi.fn();
vi.mock("./rate-control.js", () => ({
  shouldThrottleChannel: (...args: unknown[]) => shouldThrottleChannelMock(...args),
}));

const { isChannelIsolated } = await import("./channel-isolation.js");

function fakeDb(recentErrors: { errorMessage: string }[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => recentErrors,
      }),
    }),
  } as unknown as Database;
}

describe("isChannelIsolated", () => {
  beforeEach(() => {
    shouldThrottleChannelMock.mockReset();
    shouldThrottleChannelMock.mockResolvedValue({ channel: "ebay", throttle: false, reasons: [], windowMinutes: 15 });
  });

  it("is not isolated with no auth failures and a healthy throttle check", async () => {
    const result = await isChannelIsolated(fakeDb([]), "tenant-a", "ebay");

    expect(result.isolated).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("isolates on a single expired-token-with-no-refresh-token failure", async () => {
    // Confirmed live: this is exactly the real failure sales-poller hit on every 1-minute
    // cycle once the stored eBay access token expired without a refresh token to fall back on.
    const result = await isChannelIsolated(
      fakeDb([{ errorMessage: "Access token for ebay/default expired and no refresh token is stored" }]),
      "tenant-a",
      "ebay",
    );

    expect(result.isolated).toBe(true);
    expect(result.reasons[0]).toMatch(/authentication failure/);
  });

  it("isolates when there is no OAuth connection stored at all", async () => {
    const result = await isChannelIsolated(
      fakeDb([{ errorMessage: "No OAuth connection stored for ebay/default" }]),
      "tenant-a",
      "ebay",
    );

    expect(result.isolated).toBe(true);
  });

  it("does not isolate on an unrelated error message", async () => {
    const result = await isChannelIsolated(fakeDb([{ errorMessage: "eBay API error 400: bad request" }]), "tenant-a", "ebay");

    expect(result.isolated).toBe(false);
  });

  it("also isolates when the underlying rate-control throttle check fires", async () => {
    shouldThrottleChannelMock.mockResolvedValue({
      channel: "ebay",
      throttle: true,
      reasons: ["a 429 (rate limited) response was recorded for ebay's own API in the last 15min"],
      windowMinutes: 15,
    });

    const result = await isChannelIsolated(fakeDb([]), "tenant-a", "ebay");

    expect(result.isolated).toBe(true);
    expect(result.reasons).toContain("a 429 (rate limited) response was recorded for ebay's own API in the last 15min");
  });

  it("threads tenantId into the underlying rate-control throttle check, not just channel", async () => {
    await isChannelIsolated(fakeDb([]), "tenant-a", "ebay");
    expect(shouldThrottleChannelMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "ebay", expect.any(Number));
  });
});
