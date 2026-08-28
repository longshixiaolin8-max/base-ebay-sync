export interface EbayAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** eBay "RuName" (redirect URL name) registered for this application. */
  ruName: string;
  merchantLocationKey: string;
  marketplaceId?: string;
  /** Defaults to eBay production; pass the sandbox host for dev/staging environments. */
  apiBaseUrl?: string;
  authBaseUrl?: string;
}

export const EBAY_API_DEFAULT_HOST = "https://api.ebay.com";
export const EBAY_AUTH_DEFAULT_HOST = "https://auth.ebay.com";

/**
 * NOTE: verify scope identifiers against the current eBay API reference
 * (https://developer.ebay.com/api-docs/static/oauth-scopes.html) before go-live.
 */
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/sell.account",
] as const;
