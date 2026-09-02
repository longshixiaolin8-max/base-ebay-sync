/**
 * Generic idempotency guard used by every SQS-driven sync worker. The concrete storage
 * (DynamoDB or a Postgres table with a unique key + conditional insert) is injected via
 * IdempotencyStore so this module has no AWS SDK dependency.
 */
export type IdempotencyStatus = "in_progress" | "completed" | "failed";

export interface IdempotencyRecord {
  key: string;
  status: IdempotencyStatus;
  result: unknown;
}

export interface IdempotencyStore {
  /**
   * Atomically claim `key`. Must be implemented as a conditional write (INSERT ... ON
   * CONFLICT DO NOTHING / DynamoDB ConditionExpression attribute_not_exists) so that two
   * concurrent SQS deliveries of the same message can never both proceed.
   *
   * Returns the existing record if the key was already claimed by a previous attempt,
   * or null if this call just won the claim.
   */
  tryClaim(key: string, ttlSeconds: number): Promise<IdempotencyRecord | null>;
  complete(key: string, result: unknown): Promise<void>;
  /** Releases the claim (or marks it failed) so a future retry can attempt it again. */
  fail(key: string): Promise<void>;
}

export class IdempotencyInProgressError extends Error {
  constructor(readonly key: string) {
    super(`Idempotency key "${key}" is already being processed by another worker`);
    this.name = "IdempotencyInProgressError";
  }
}

/** Builds a stable, human-debuggable idempotency key from ordered parts. */
export function buildIdempotencyKey(parts: Array<string | number>): string {
  return parts.map((p) => String(p).replace(/:/g, "_")).join(":");
}

/**
 * Runs `fn` at most once for a given key. Safe to call repeatedly with the same key
 * (e.g. on SQS redelivery) — a completed run replays its cached result, an in-progress
 * run raises IdempotencyInProgressError so the caller can let SQS retry later instead of
 * doing duplicate work (double-listing, double-decrementing inventory, etc).
 */
export async function withIdempotency<T>(
  store: IdempotencyStore,
  key: string,
  fn: () => Promise<T>,
  ttlSeconds = 24 * 3600,
): Promise<T> {
  const existing = await store.tryClaim(key, ttlSeconds);
  if (existing) {
    if (existing.status === "completed") {
      return existing.result as T;
    }
    if (existing.status === "in_progress") {
      throw new IdempotencyInProgressError(key);
    }
    // status === "failed": tryClaim implementations should re-claim automatically; if a
    // store implementation instead surfaces the stale failed record, retry inline.
  }

  try {
    const result = await fn();
    await store.complete(key, result);
    return result;
  } catch (err) {
    await store.fail(key);
    throw err;
  }
}
