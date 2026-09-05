import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { shouldThrottleChannel } from "./rate-control.js";

function fakeDb(recentErrors: { errorMessage: string }[]): Database {
  return {
    select: () => ({
      from: () => ({
        where: async () => recentErrors,
      }),
    }),
  } as unknown as Database;
}

describe("shouldThrottleChannel", () => {
  it("does not throttle with no recent errors", async () => {
    const result = await shouldThrottleChannel(fakeDb([]), "ebay");

    expect(result.throttle).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it("throttles on a real 429 from the channel's own API", async () => {
    const result = await shouldThrottleChannel(
      fakeDb([{ errorMessage: "eBay API error 429: Too Many Requests" }]),
      "ebay",
    );

    expect(result.throttle).toBe(true);
    expect(result.reasons[0]).toMatch(/429/);
  });

  it("throttles on repeated 5xx responses even without an explicit 429", async () => {
    const result = await shouldThrottleChannel(
      fakeDb([
        { errorMessage: "eBay API error 503: Service Unavailable" },
        { errorMessage: "eBay API error 502: Bad Gateway" },
        { errorMessage: "eBay API error 500: Internal Server Error" },
      ]),
      "ebay",
    );

    expect(result.throttle).toBe(true);
    expect(result.apiErrorCount).toBe(3);
  });

  it("does not throttle on a single 5xx — that's not yet a pattern", async () => {
    const result = await shouldThrottleChannel(fakeDb([{ errorMessage: "eBay API error 500: Internal Server Error" }]), "ebay");

    expect(result.throttle).toBe(false);
  });

  it("does not throttle on 4xx client errors — a malformed request is our bug, not the channel's API being unhealthy", async () => {
    // Regression: confirmed live that stale/already-fixed validation bugs (invalid
    // condition, missing item specific) showed up as repeated 400s and must never slow
    // down real sale polling — slowing the schedule wouldn't fix a bad request anyway.
    const result = await shouldThrottleChannel(
      fakeDb([
        { errorMessage: "eBay API error 400: Invalid request" },
        { errorMessage: "eBay API error 400: Invalid request" },
        { errorMessage: "eBay API error 400: Invalid request" },
        { errorMessage: "eBay API error 404: Not Found" },
      ]),
      "ebay",
    );

    expect(result.throttle).toBe(false);
    expect(result.apiErrorCount).toBe(0);
  });

  it("ignores errors that don't come from the channel's own adapter, however many there are", async () => {
    // Regression: confirmed live that Bedrock quota errors from ai-generate-worker are
    // recorded with channel:"ebay" too (they block an eBay listing) even though they say
    // nothing about eBay's own API health -- these must never trigger a throttle.
    const result = await shouldThrottleChannel(
      fakeDb(
        Array.from({ length: 50 }, () => ({ errorMessage: "Too many tokens per day, please wait before trying again." })),
      ),
      "ebay",
    );

    expect(result.throttle).toBe(false);
    expect(result.apiErrorCount).toBe(0);
  });
});
