import { EbayApiError, EbayPartialUpdateRolledBackError } from "@ai-ec/adapter-ebay";

/**
 * A blocked seller account requires a human change in eBay Seller Hub.
 * Do not confuse this with errorId 25002 on its own: eBay also reports
 * item-specific validation failures under that identifier.
 */
export function isNonRetryableEbaySellerSetupError(error: unknown): boolean {
  const cause = error instanceof EbayPartialUpdateRolledBackError ? error.cause : error;
  if (!(cause instanceof EbayApiError)) return false;
  return /SELLING_PRIVILEGE_REQUIRED|(?:required|necessary) selling privileges|(?:do(?:es)? not have|without) (?:the )?(?:required )?selling privileges|(?:create|register) (?:a )?seller['’]?s account/i.test(
    cause.body,
  );
}
