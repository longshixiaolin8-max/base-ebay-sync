import { getDb, recordAuditLog, redriveDlq } from "@ai-ec/lambda-shared";

interface DlqTarget {
  name: string;
  url: string;
  arn: string;
}

function targetsFromEnv(): DlqTarget[] {
  const names = ["AI_GENERATE", "EBAY_SYNC", "INVENTORY_SYNC"];
  return names
    // Do not auto-redrive eBay publish/update jobs without confirming seller
    // privileges are fixed: a poisoned DLQ previously recycled every 30min.
    // An explicit infra-level opt-in is required to restore this behavior.
    .filter((name) => name !== "EBAY_SYNC" || process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED === "true")
    .map((name) => ({
      name,
      url: process.env[`${name}_DLQ_URL`],
      arn: process.env[`${name}_DLQ_ARN`],
    }))
    .filter((t): t is DlqTarget => Boolean(t.url && t.arn)) as DlqTarget[];
}

/**
 * Scheduled recovery step (item #4, "API障害後の自動復旧"): every run, redrive any DLQ that
 * currently has messages back to its source queue via SQS's native message-move-task
 * feature, so a transient outage (eBay/BASE briefly down, a Bedrock quota hiccup) recovers
 * on its own instead of sitting in the DLQ until an admin notices and clicks retry.
 * eBay's DLQ is excluded by default because a seller-privilege block cannot heal
 * automatically and repeated publish attempts consume resources indefinitely.
 * Each redriven message still goes through the source queue's maxReceiveCount;
 * operators must inspect any repeating AI/inventory failures as well.
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
}
