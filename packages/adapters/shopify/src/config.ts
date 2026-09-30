export interface ShopifyAdapterConfig {
  /** The store's own subdomain, e.g. "my-store" for my-store.myshopify.com. */
  shopDomain: string;
  clientId: string;
  clientSecret: string;
  /**
   * Shopify's Inventory API sets stock per (inventory_item_id, location_id) pair, not per
   * product/variant alone -- there is no single "set this item's quantity" call without a
   * location. This platform has no per-tenant concept of "which Shopify location", so (like
   * eBay's merchantLocationKey) this is a single default location configured once per tenant.
   */
  defaultLocationId: string;
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
 */
export const SHOPIFY_OAUTH_SCOPES = ["read_products", "write_products", "read_orders", "read_inventory", "write_inventory"] as const;
