import { getDb, isEbayProductSyncRetryable, recordAuditLog, redriveDlq, redriveDlqSelectively } from "@ai-ec/lambda-shared";

interface DlqTarget {
  name: string;
  url: string;
  arn: string;
}

function targetsFromEnv(): DlqTarget[] {
  // EBAY_SYNC is handled separately below, via a selective per-message redrive, not this
  // wholesale StartMessageMoveTask path -- see redriveEbaySyncDlq's own doc comment.
  const names = ["AI_GENERATE", "INVENTORY_SYNC"];
  return names
    .map((name) => ({
      name,
      url: process.env[`${name}_DLQ_URL`],
      arn: process.env[`${name}_DLQ_ARN`],
    }))
    .filter((t): t is DlqTarget => Boolean(t.url && t.arn)) as DlqTarget[];
}

interface EbaySyncDlqMessage {
  tenantId: string;
  productId?: string;
}

/**
 * Selective recovery for the eBay sync DLQ (item #4, "API障害後の自動復旧", eBay's own
 * carve-out): ebay-sync-worker's handler already guarantees a seller-privilege failure
 * (SELLING_PRIVILEGE_REQUIRED) is acknowledged and never pushed to batchItemFailures, so it
 * can never reach this DLQ in the first place -- only a genuinely retryable failure that
 * exhausted maxReceiveCount (a prolonged eBay outage, a transient 5xx run) ever lands here.
 * That upstream guarantee is exactly what makes per-message redrive safe to enable at all:
 * isEbayProductSyncRetryable still re-checks each message's own sync_errors history before
 * resubmitting it, both as defense in depth and to catch any message that predates that
 * worker-side classification (recorded under an older, less specific errorCode or only a raw
 * errorMessage).
 *
 * Still gated behind EBAY_SYNC_AUTO_REDRIVE_ENABLED (unset/false by default in
 * lambda-stack.ts) -- unlike the old wholesale redrive this replaces, enabling this one is now
 * actually safe to turn on, but flipping that production switch is an infra/operator decision
 * this function deliberately leaves alone.
 */
async function redriveEbaySyncDlq(db: ReturnType<typeof getDb>): Promise<void> {
  if (process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED !== "true") return;
  const dlqUrl = process.env.EBAY_SYNC_DLQ_URL;
  const sourceQueueUrl = process.env.EBAY_SYNC_QUEUE_URL;
  if (!dlqUrl || !sourceQueueUrl) return;

  const result = await redriveDlqSelectively(dlqUrl, sourceQueueUrl, async (body) => {
    let message: EbaySyncDlqMessage;
    try {
      message = JSON.parse(body) as EbaySyncDlqMessage;
    } catch {
      return true; // Unparseable body can't be classified -- fail open to the existing retry mechanics.
    }
    return isEbayProductSyncRetryable(db, message.tenantId, message.productId);
  });

  if (result.redriven > 0 || result.skipped > 0) {
    await recordAuditLog(db, {
      tenantId: null,
      actor: "system:dlq-redrive",
      action: "dlq_redrive_selective",
      entityType: "queue",
      entityId: "EBAY_SYNC",
      after: result,
    });
  }
}

/**
 * Scheduled recovery step (item #4, "API障害後の自動復旧"): every run, redrive any DLQ that
 * currently has messages back to its source queue, so a transient outage (BASE briefly down,
 * a Bedrock quota hiccup) recovers on its own instead of sitting in the DLQ until an admin
 * notices and clicks retry. Each redriven message still goes through the source queue's
 * maxReceiveCount; operators must inspect any repeating AI/inventory failures as well.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const targets = targetsFromEnv();

  for (const target of targets) {
    const result = await redriveDlq(target.url, target.arn);
    if (result.started) {
      await recordAuditLog(db, {
        // Platform-level, not any one tenant's action -- a redrive moves whatever's in the
        // shared DLQ regardless of whose messages they are (see auditLog's tenantId comment).
        tenantId: null,
        actor: "system:dlq-redrive",
        action: "dlq_redrive_started",
        entityType: "queue",
        entityId: target.name,
        after: { taskHandle: result.taskHandle },
      });
    }
  }

  await redriveEbaySyncDlq(db);
}
