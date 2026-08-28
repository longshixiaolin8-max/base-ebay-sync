import { describe, expect, it, vi } from "vitest";
import {
  IdempotencyInProgressError,
  type IdempotencyRecord,
  type IdempotencyStore,
  buildIdempotencyKey,
  withIdempotency,
} from "./idempotency.js";

function createInMemoryStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  return {
    async tryClaim(key) {
      const existing = records.get(key);
      if (existing && existing.status !== "failed") return existing;
      records.set(key, { key, status: "in_progress", result: null });
      return null;
    },
    async complete(key, result) {
      records.set(key, { key, status: "completed", result });
    },
    async fail(key) {
      records.set(key, { key, status: "failed", result: null });
    },
  };
}

describe("buildIdempotencyKey", () => {
  it("joins parts deterministically", () => {
    expect(buildIdempotencyKey(["inventory_sync", "product-1", "order-9"])).toBe(
      "inventory_sync:product-1:order-9",
    );
  });
});

describe("withIdempotency", () => {
  it("runs the function exactly once and replays the cached result on redelivery", async () => {
    const store = createInMemoryStore();
    const fn = vi.fn().mockResolvedValue({ quantity: 0 });

    const first = await withIdempotency(store, "k1", fn);
    const second = await withIdempotency(store, "k1", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ quantity: 0 });
    expect(second).toEqual({ quantity: 0 });
  });

  it("throws IdempotencyInProgressError for a concurrent in-flight claim instead of double-running", async () => {
    const store = createInMemoryStore();
    let resolveFirst: (() => void) | undefined;
    const slowFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = () => resolve("done");
        }),
    );

    const firstCall = withIdempotency(store, "sale-order-1", slowFn);
    // Second delivery of the "same" SQS message arrives before the first finishes.
    await expect(withIdempotency(store, "sale-order-1", slowFn)).rejects.toBeInstanceOf(
      IdempotencyInProgressError,
    );

    resolveFirst?.();
    await expect(firstCall).resolves.toBe("done");
    expect(slowFn).toHaveBeenCalledTimes(1);
  });

  it("releases the claim on failure so a later retry can succeed", async () => {
    const store = createInMemoryStore();
    const fn = vi.fn().mockRejectedValueOnce(new Error("eBay API 500")).mockResolvedValueOnce("ok");

    await expect(withIdempotency(store, "k2", fn)).rejects.toThrow("eBay API 500");
    await expect(withIdempotency(store, "k2", fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
