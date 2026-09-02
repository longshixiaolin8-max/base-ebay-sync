export interface EbayAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** eBay "RuName" (redirect URL name) registered for this application. */
  ruName: string;
  merchantLocationKey: string;
  marketplaceId?: string;
  /**
   * eBay Business Policy IDs (fulfillment/payment/return) required on every offer before it
   * can publish. Create them once via EbayAdapter's policy-creation methods.
   */
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
  /** Defaults to eBay production; pass the sandbox host for dev/staging environments. */
  apiBaseUrl?: string;
  authBaseUrl?: string;
}

export const EBAY_API_DEFAULT_HOST = "https://api.ebay.com";
export const EBAY_AUTH_DEFAULT_HOST = "https://auth.ebay.com";
export const EBAY_API_SANDBOX_HOST = "https://api.sandbox.ebay.com";
export const EBAY_AUTH_SANDBOX_HOST = "https://auth.sandbox.ebay.com";

/**
 * NOTE: verify scope identifiers against the current eBay API reference
 * (https://developer.ebay.com/api-docs/static/oauth-scopes.html) before go-live.
 */
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  // sell.listing.read would be required to subscribe to the Notification API's LISTING
  // topic, but this app's Sandbox keyset does not have access to it (confirmed live: eBay
  // rejects both the authorize request and every token refresh with invalid_scope once it's
  // requested). Do not re-add it here without first confirming eBay has granted the scope —
  // requesting an unavailable scope breaks token refresh for every other eBay call too, not
  // just the ones that need it. ebay-webhook stays deployed and dormant until then.
] as const;
