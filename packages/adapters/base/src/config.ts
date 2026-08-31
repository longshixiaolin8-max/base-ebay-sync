export interface BaseAdapterConfig {
  clientId: string;
  clientSecret: string;
  /** Defaults to BASE's production API host; override for BASE's sandbox environment in tests/dev. */
  apiBaseUrl?: string;
}

export const BASE_API_DEFAULT_HOST = "https://api.thebase.in";

/**
 * BASE OAuth scopes required by this platform. Verified against BASE's real scope list
 * (read_users[_mail], read_items, read_orders, read_savings, write_items, write_orders —
 * there is no separate "*_items_stock" scope; stock is a field on the item update call,
 * covered by write_items). Confirmed live: BASE rejects an unknown scope as
 * "invalid_request" and expects the list space-separated, not comma-separated.
 */
export const BASE_OAUTH_SCOPES = ["read_items", "write_items", "read_orders"] as const;
