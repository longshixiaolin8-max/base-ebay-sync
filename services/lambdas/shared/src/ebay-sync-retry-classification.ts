import { isSellerSetupRequiredMessage } from "@ai-ec/core";
import { and, desc, eq } from "drizzle-orm";
import { syncErrors, type Database } from "@ai-ec/db";

/**
 * dlq-redrive's classifier for the eBay sync DLQ's selective redrive (see sqs.ts's
 * redriveDlqSelectively): a DLQ message itself is just `{type, tenantId, productId}` -- it
 * carries no record of *why* it failed, only sync_errors does. This looks up that product's
 * most recent eBay sync_errors row and treats it as non-retryable exactly when
 * ebay-sync-worker's own handler would have (see its isNonRetryableEbaySellerSetupError /
 * EbaySyncQuotaExceededError handling): a seller-privilege block, by its recorded errorCode
 * or (for a message that predates that errorCode existing) by its errorMessage text matching
 * the exact same classifier the worker itself uses.
 *
 * No matching sync_errors row (a cleared/resolved one, or a worker-recorded entry that races
 * ahead of this lookup) defaults to retryable -- the worker already guarantees today that a
 * non-retryable failure is acknowledged, never pushed to batchItemFailures, so it can never
 * reach the DLQ in the first place; the only messages genuinely waiting here are ones that
 * exhausted retries on a real, retryable failure.
 */
export async function isEbayProductSyncRetryable(db: Database, tenantId: string, productId: string | null | undefined): Promise<boolean> {
  if (!productId) return true;

  const [latest] = await db
    .select({ errorCode: syncErrors.errorCode, errorMessage: syncErrors.errorMessage })
    .from(syncErrors)
    .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.productId, productId), eq(syncErrors.channel, "ebay")))
    .orderBy(desc(syncErrors.createdAt))
    .limit(1);
  if (!latest) return true;

  if (latest.errorCode === "ebay_seller_setup_required") return false;
  return !isSellerSetupRequiredMessage(latest.errorMessage);
}
