import { auditLog, syncErrors, type Database } from "@ai-ec/db";
import { emitSyncErrorMetric } from "./metrics.js";

/**
 * `tenantId` is required, not optional -- so every call site across admin-api and every
 * worker fails to compile until it's threaded through, rather than silently omitting tenant
 * scoping on a new call site. It's typed `string | null` (not just `string`) specifically for
 * the small number of genuine platform/system-level events (e.g. dlq-redrive's queue-wide
 * redrive, which describes shared infrastructure, not any one tenant's action) -- callers
 * pass `null` for those consciously, rather than a real tenant id being accidentally omitted.
 */
export async function recordAuditLog(
  db: Database,
  entry: {
    tenantId: string | null;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    tenantId: entry.tenantId,
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
    tenantId: string;
    jobId?: string | null;
    channel?: string | null;
    productId?: string | null;
    errorCode: string;
    errorMessage: string;
    payload?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.insert(syncErrors).values({
    tenantId: entry.tenantId,
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
