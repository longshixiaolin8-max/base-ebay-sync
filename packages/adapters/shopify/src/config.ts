export interface ShopifyAdapterConfig {
  /**
   * The store's own subdomain, e.g. "my-store" for my-store.myshopify.com. OPTIONAL: the
   * platform's shared, no-shop-known ShopifyAdapter singleton (see loadImplementedChannelAdapters
   * in @ai-ec/lambda-shared) is constructed with this unset, since one shared instance is reused
   * across every tenant's own store. Per-product calls instead carry the shop domain inside
   * their own externalId ("{shopDomain}::{productId}"); only a per-request instance (built fresh
   * in oauth-shopify / shopify-sync-worker, where the domain is already known from context) sets
   * this, for OAuth and createListing, which have no externalId to carry one in. See
   * ShopifyAdapter's own class doc comment in client.ts for the full rationale.
   */
  shopDomain?: string;
  clientId: string;
  clientSecret: string;
  /** Shopify Admin API version this client targets. Shopify requires one on every REST call
   *  and deprecates old versions on a quarterly cycle -- pin it explicitly rather than
   *  silently drifting onto whatever "latest" resolves to at request time. */
  apiVersion?: string;
}

export const SHOPIFY_API_DEFAULT_VERSION = "2024-01";

/**
 * Shopify Admin API scopes this adapter's method surface actually needs. Unlike BASE/eBay,
 * this has NOT been confirmed against a live Shopify Partner app -- verify against Shopify's
 * current scope reference (shopify.dev/docs/api/usage/access-scopes) before requesting
 * these in a real OAuth app.
 *
 * read_locations is its own separate scope from read_inventory/write_inventory in Shopify's
 * reference -- easy to miss since "inventory" sounds like it would cover "where is this
 * inventory" too, but it doesn't. Without it, setInventory()'s own GET /locations.json call
 * (see resolveDefaultLocationId in client.ts) 403s for every real connected store, which
 * would otherwise have silently blocked every Shopify inventory push.
 */
export const SHOPIFY_OAUTH_SCOPES = [
  "read_products",
  "write_products",
  "read_orders",
  "read_inventory",
  "write_inventory",
  "read_locations",
] as const;
