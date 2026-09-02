import { auditLog, syncErrors, type Database } from "@ai-ec/db";

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
}
