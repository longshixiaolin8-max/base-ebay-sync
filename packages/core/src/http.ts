export interface FetchWithRetryOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Total attempts for safe read methods (GET/HEAD), including the first request. */
  maxAttempts?: number;
  /** Initial exponential-backoff delay. */
  baseDelayMs?: number;
  /** Upper bound for exponential backoff and Retry-After waits. */
  maxDelayMs?: number;
  /** Injection hooks keep unit tests deterministic and free of real sleeps. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class HttpRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms`);
    this.name = "HttpRequestTimeoutError";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryAfterMs(response: Response, now: () => number): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - now());
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Fetch wrapper for external APIs.
 *
 * Only GET/HEAD requests are retried automatically. Mutating requests still receive a
 * timeout, but never get replayed here: the caller must explicitly opt into any write
 * retry only when the remote operation is proven idempotent.
 *
 * The helper deliberately does not log request URLs, headers, or bodies, so bearer
 * tokens/client secrets cannot leak from generic retry handling.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const retrySafe = method === "GET" || method === "HEAD";
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxAttempts = retrySafe ? Math.max(1, options.maxAttempts ?? 3) : 1;
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 250);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 5_000);
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const parentSignal = init.signal;

    const onParentAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const retryable = retrySafe && shouldRetryStatus(response.status) && attempt < maxAttempts;
      if (!retryable) return response;

      // We will discard this response and issue another request. Canceling the body lets
      // Node/undici release the stream promptly instead of retaining it until GC.
      try {
        await response.body?.cancel();
      } catch {
        // Best effort only; retry behavior must not depend on body cancellation support.
      }

      const headerDelay = retryAfterMs(response, now);
      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = exponential * (0.5 + random());
      const delayMs = Math.min(maxDelayMs, headerDelay ?? jittered);
      if (delayMs > 0) await sleep(delayMs);
    } catch (error) {
      if (parentSignal?.aborted) throw error;

      const canRetry = retrySafe && attempt < maxAttempts;
      if (!canRetry) {
        if (timedOut) throw new HttpRequestTimeoutError(timeoutMs);
        throw error;
      }

      const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = exponential * (0.5 + random());
      if (delayMs > 0) await sleep(delayMs);
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    }
  }

  // The loop always returns or throws. This keeps TypeScript exhaustive if options change.
  throw new Error("HTTP retry loop exhausted unexpectedly");
}
