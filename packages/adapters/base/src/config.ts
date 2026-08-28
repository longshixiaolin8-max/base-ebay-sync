export interface BaseAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** Defaults to BASE's production API host; override for BASE's sandbox environment in tests/dev. */
  apiBaseUrl?: string;
}

export const BASE_API_DEFAULT_HOST = "https://api.thebase.in";

/**
 * BASE OAuth scopes required by this platform.
 * NOTE: verify the exact scope identifiers against the current BASE API reference
 * (https://docs.thebase.in) for the merchant's app registration before go-live —
 * BASE occasionally renames scopes between API versions.
 */
export const BASE_OAUTH_SCOPES = [
  "read_items",
  "write_items",
  "read_items_stock",
  "write_items_stock",
  "read_orders",
] as const;
