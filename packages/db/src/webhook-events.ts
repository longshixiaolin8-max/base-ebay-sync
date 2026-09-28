import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { processedWebhookEvents } from "./schema.js";

export type WebhookEventStatus = "received" | "processing" | "completed" | "failed";

/** A "processing" claim older than this is assumed abandoned (Lambda timeout, a crashed
 *  process, a killed container) and becomes reclaimable, exactly like an explicitly
 *  "failed" one -- otherwise a delivery that dies mid-flight, with no error ever recorded,
 *  would stay claimed forever and could never be retried. Comfortably above this Lambda's
 *  own configured timeout (see infra/lib/lambda-stack.ts's makeFn default of 30s). */
export const STUCK_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000;

export interface ClaimWebhookEventResult {
  claimed: boolean;
  /** Set only when claimed is false: the status actually found, so the caller can tell a
   *  true duplicate ("completed") from a delivery some other invocation is still (or was
   *  recently) working on ("processing", within its staleness window). */
  status?: WebhookEventStatus;
}

/**
 * Claims a webhook delivery for processing -- the "inbox" half of the Inbox pattern. A
 * claim ("received a delivery, safe to start business logic") is deliberately NOT the same
 * thing as completeWebhookEvent below ("the business logic actually finished"): keeping
 * them separate is exactly what lets a delivery that crashes mid-flight be retried instead
 * of being silently mistaken for already-done just because a row exists for it.
 *
 * Atomic: the same INSERT ... ON CONFLICT ... WHERE this codebase already uses for its
 * idempotency-key store (see idempotency-store.ts) — two concurrent claims of the same
 * (source, eventId) can never both succeed, because Postgres serializes conflicting
 * upserts on the same row; only one attempt's UPDATE can ever satisfy the WHERE and return
 * a row, no matter how many callers race here at once.
 */
export async function claimWebhookEvent(
  db: Database,
  source: string,
  eventId: string,
  now: Date = new Date(),
): Promise<ClaimWebhookEventResult> {
  const id = `${source}:${eventId}`;
  const staleBefore = new Date(now.getTime() - STUCK_PROCESSING_THRESHOLD_MS);

  const claimed = await db
    .insert(processedWebhookEvents)
    .values({ id, source, status: "processing", attempts: 1, lastError: null, updatedAt: now })
    .onConflictDoUpdate({
      target: processedWebhookEvents.id,
      set: { status: "processing", attempts: sql`${processedWebhookEvents.attempts} + 1`, lastError: null, updatedAt: now },
      // Only a previously-failed or stuck-processing row is reclaimable -- a completed row,
      // or a processing one still within its staleness window, is left untouched (this WHERE
      // is what makes the upsert conditional, matching DO NOTHING's shape for every other case).
      where: or(
        eq(processedWebhookEvents.status, "failed"),
        and(eq(processedWebhookEvents.status, "processing"), lt(processedWebhookEvents.updatedAt, staleBefore)),
      ),
    })
    .returning({ id: processedWebhookEvents.id });

  if (claimed.length > 0) {
    return { claimed: true };
  }

  const [existing] = await db
    .select({ status: processedWebhookEvents.status })
    .from(processedWebhookEvents)
    .where(eq(processedWebhookEvents.id, id))
    .limit(1);

  // Missing here would mean we lost a race with a concurrent insert between our own
  // INSERT..ON CONFLICT and this read -- vanishingly unlikely (the row we just conflicted
  // with must already exist), but "processing" is the safe default: it tells the caller to
  // treat this as still in flight rather than silently ack it as done.
  return { claimed: false, status: (existing?.status as WebhookEventStatus | undefined) ?? "processing" };
}

/** Marks a claimed delivery's business logic as having actually completed. Call this only
 *  after every DB mutation the event describes has itself committed -- see stripe-webhook's
 *  own handler, which wraps both in one transaction so this and the mutation it's
 *  confirming can never disagree about whether the event was really applied. */
export async function completeWebhookEvent(
  db: Pick<Database, "update">,
  source: string,
  eventId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(processedWebhookEvents)
    .set({ status: "completed", lastError: null, updatedAt: now })
    .where(eq(processedWebhookEvents.id, `${source}:${eventId}`));
}

/** Marks a claimed delivery as failed, making it reclaimable on the next redelivery
 *  (Stripe/eBay/etc. all retry on a non-2xx response). Always called from outside the
 *  failed transaction itself (a rolled-back transaction can't record its own failure). */
export async function failWebhookEvent(db: Database, source: string, eventId: string, errorMessage: string, now: Date = new Date()): Promise<void> {
  await db
    .update(processedWebhookEvents)
    .set({ status: "failed", lastError: errorMessage, updatedAt: now })
    .where(eq(processedWebhookEvents.id, `${source}:${eventId}`));
}
