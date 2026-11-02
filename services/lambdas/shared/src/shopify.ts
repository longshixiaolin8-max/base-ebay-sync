import { ShopifyAdapter } from "@ai-ec/adapter-shopify";

export interface ShopifyAppCredentials {
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
}

/**
 * Builds a ShopifyAdapter. `shopDomain` is omitted for the shared singleton instance
 * loadImplementedChannelAdapters() builds (every per-product method parses its own shop
 * domain out of its `"{shopDomain}::{productId}"` externalId instead -- see ShopifyAdapter's
 * own class doc comment in @ai-ec/adapter-shopify), and passed explicitly only by a
 * per-request instance (oauth-shopify's callback, shopify-sync-worker's publish/update),
 * both of which already know which store they're acting for from their own context.
 */
export function createShopifyAdapter(creds: ShopifyAppCredentials, shopDomain?: string): ShopifyAdapter {
  return new ShopifyAdapter({ ...creds, shopDomain });
}

/**
 * Shopify's own `?shop=` query param (present on both the install redirect this platform
 * sends merchants to and the callback Shopify redirects back to) carries either the bare
 * store subdomain ("my-store") or the full myshopify.com host ("my-store.myshopify.com") --
 * normalized to the bare subdomain form ShopifyAdapterConfig.shopDomain expects either way.
 *
 * Strictly validated (not just normalized) because this value is used, unescaped, to build
 * a URL this platform's own servers then fetch (https://{shopDomain}.myshopify.com/...) --
 * an unvalidated `shop` param is a direct SSRF vector (e.g. a value containing its own
 * scheme/host/credentials). Real Shopify shop subdomains are always lowercase
 * alphanumeric-and-hyphens; anything else is rejected outright rather than sanitized.
 */
export function normalizeShopDomain(rawShop: string): string {
  const stripped = rawShop.trim().toLowerCase().replace(/\.myshopify\.com$/, "");
  if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(stripped)) {
    throw new Error(`Invalid Shopify shop domain: ${JSON.stringify(rawShop)}`);
  }
  return stripped;
}
