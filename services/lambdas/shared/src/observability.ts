import { auditLog, syncErrors, type Database } from "@ai-ec/db";
import { emitSyncErrorMetric } from "./metrics.js";

export async function recordAuditLog(
  db: Database,
  entry: {
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
}

/**
 * Every caught sync failure is written here so it shows up in the admin error dashboard,
 * in addition to (not instead of) letting the exception propagate so SQS/Lambda's own
 * retry + DLQ mechanics still apply.
 */
export async function recordSyncError(
  db: Database,
  entry: {
    jobId?: string | null;
    channel?: string | null;
    productId?: string | null;
    errorCode: string;
    errorMessage: string;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(syncErrors).values({
    jobId: entry.jobId ?? null,
    channel: entry.channel ?? null,
    productId: entry.productId ?? null,
    errorCode: entry.errorCode,
    errorMessage: entry.errorMessage,
    payload: entry.payload ?? null,
  });
  // A repeated failure (e.g. the Bedrock daily-token-quota outage) can complete every retry
  // "successfully" from Lambda's own point of view -- caught, logged here, no exception
  // escapes -- so it never trips CloudWatch's per-function Errors alarm. This metric is the
  // only thing that lets MonitoringStack notice and email the user about it.
  emitSyncErrorMetric(entry.channel, entry.errorCode);
}
