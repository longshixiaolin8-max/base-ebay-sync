import type { Database } from "./client.js";
import { processedWebhookEvents } from "./schema.js";

/**
 * Claims a webhook delivery for processing. Returns true the first time a given
 * (source, id) pair is seen -- the caller should process the event. Returns false on any
 * later delivery of the same event (Stripe retries on non-2xx, and can occasionally
 * redeliver an already-acked event) -- the caller should skip processing and just ack.
 */
export async function claimWebhookEvent(db: Database, source: string, eventId: string): Promise<boolean> {
  const claimed = await db
    .insert(processedWebhookEvents)
    .values({ id: `${source}:${eventId}`, source })
    .onConflictDoNothing({ target: processedWebhookEvents.id })
    .returning({ id: processedWebhookEvents.id });
  return claimed.length > 0;
}
