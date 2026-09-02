import { getDb, recordAuditLog, redriveDlq } from "@ai-ec/lambda-shared";

interface DlqTarget {
  name: string;
  url: string;
  arn: string;
}

function targetsFromEnv(): DlqTarget[] {
  const names = ["AI_GENERATE", "EBAY_SYNC", "INVENTORY_SYNC"];
  return names
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
 * on its own instead of sitting in the DLQ until an admin notices and clicks retry. Each
 * redriven message still goes through the source queue's full maxReceiveCount before
 * landing back in the DLQ if the underlying failure wasn't transient — this is a bounded,
 * low-frequency safety net (one attempt per scheduled run), not a tight retry loop.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const targets = targetsFromEnv();

  for (const target of targets) {
    const result = await redriveDlq(target.url, target.arn);
    if (result.started) {
      await recordAuditLog(db, {
        actor: "system:dlq-redrive",
        action: "dlq_redrive_started",
        entityType: "queue",
        entityId: target.name,
        after: { taskHandle: result.taskHandle },
      });
    }
  }
}
