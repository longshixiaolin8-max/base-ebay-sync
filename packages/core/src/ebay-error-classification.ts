/**
 * Pure text classifier shared by two independent callers that each only have a *string* to
 * judge, never the same structured error object:
 *  - ebay-sync-worker's retry-policy.ts (isNonRetryableEbaySellerSetupError), which extracts
 *    this from a live EbayApiError's response body right when the failure happens.
 *  - dlq-redrive's selective eBay-queue redrive, which only has sync_errors' stored
 *    errorMessage text to go on, long after the original error object is gone.
 * Kept in one place so the two can never drift apart on what counts as "this seller needs to
 * fix their eBay account before anything will succeed," which both must agree on exactly --
 * one decides whether to keep retrying, the other decides whether a sitting DLQ message is
 * safe to automatically resubmit.
 */
export function isSellerSetupRequiredMessage(text: string): boolean {
  return /SELLING_PRIVILEGE_REQUIRED|(?:required|necessary) selling privileges|(?:do(?:es)? not have|without) (?:the )?(?:required )?selling privileges|(?:create|register) (?:a )?seller['’]?s account/i.test(
    text,
  );
}
