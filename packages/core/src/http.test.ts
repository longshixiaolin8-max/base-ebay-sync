import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, HttpRequestTimeoutError } from "./http.js";

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("retries 429 reads and honors Retry-After", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/read", {}, { sleep, random: () => 0 });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("retries 5xx reads and eventually succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/read", {}, { sleep, random: () => 0 });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("returns the final 503 after max attempts so the adapter can raise its typed API error", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "https://example.test/read",
      {},
      { maxAttempts: 3, sleep, random: () => 0 },
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-retryable 4xx responses", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry("https://example.test/read", {}, { sleep });

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("never automatically retries mutating requests", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchWithRetry(
      "https://example.test/write",
      { method: "POST", body: "{}" },
      { maxAttempts: 5, sleep },
    );

    expect(response.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("times out without exposing request credentials in the thrown message", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = fetchWithRetry(
      "https://example.test/private",
      { method: "POST", headers: { Authorization: "Bearer super-secret-token" } },
      { timeoutMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(100);

    await expect(promise).rejects.toBeInstanceOf(HttpRequestTimeoutError);
    await expect(promise).rejects.not.toThrow(/super-secret-token/);
  });
});
