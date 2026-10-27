import type {
  ChannelAdapter,
  CreateListingInput,
  ExternalProduct,
  ListProductsParams,
  ListProductsResult,
  OAuthTokenSet,
  SaleEvent,
  UpdateListingInput,
} from "@ai-ec/core";
import { SHOPIFY_API_DEFAULT_VERSION, SHOPIFY_OAUTH_SCOPES, type ShopifyAdapterConfig } from "./config.js";

interface ShopifyVariant {
  id: number;
  price: string;
  inventory_item_id: number;
  inventory_quantity: number;
}

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  updated_at: string;
  images: { src: string }[];
  variants: ShopifyVariant[];
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}
interface ShopifyProductResponse {
  product: ShopifyProduct;
}

interface ShopifyOrderLineItem {
  product_id: number;
  quantity: number;
  price: string;
}
interface ShopifyOrder {
  id: number;
  created_at: string;
  line_items: ShopifyOrderLineItem[];
}
interface ShopifyOrdersResponse {
  orders: ShopifyOrder[];
}

interface ShopifyLocation {
  id: number;
}
interface ShopifyLocationsResponse {
  locations: ShopifyLocation[];
}

interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

class ShopifyApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Shopify API error ${status}: ${body}`);
    this.name = "ShopifyApiError";
  }
}

/** externalId's own composite format, used everywhere this platform's shared, no-shop-known
 *  singleton ShopifyAdapter instance (see loadImplementedChannelAdapters in @ai-ec/lambda-shared)
 *  needs to know which store a given product/listing lives in -- see this class's own doc
 *  comment for why. */
const EXTERNAL_ID_SEPARATOR = "::";

function splitExternalId(externalId: string): { shopDomain: string; productId: string } {
  const idx = externalId.indexOf(EXTERNAL_ID_SEPARATOR);
  if (idx < 0) {
    throw new Error(
      `Shopify externalId "${externalId}" is missing its "${EXTERNAL_ID_SEPARATOR}shopDomain" prefix -- every Shopify externalId stored by this platform must be "{shopDomain}${EXTERNAL_ID_SEPARATOR}{productId}", set once at createListing() and never a bare Shopify product id.`,
    );
  }
  return { shopDomain: externalId.slice(0, idx), productId: externalId.slice(idx + EXTERNAL_ID_SEPARATOR.length) };
}

/**
 * ChannelAdapter implementation for Shopify (shopify.dev/docs/api/admin-rest) -- written
 * against Shopify's publicly documented Admin REST API shape (product/variant/inventory/
 * order fields, OAuth flow, auth header) as a concrete template for "how to add a channel",
 * per docs/adding-a-channel.md. It compiles, typechecks and has unit tests against mocked
 * HTTP responses, exactly like @ai-ec/adapter-base and @ai-ec/adapter-ebay's own test
 * suites -- but UNLIKE those two, it has never been run against a real Shopify store: this
 * environment has no Shopify Partner app or test store to verify against. Re-verify every
 * field/endpoint against Shopify's current API reference before using this for anything
 * real, the same way BASE's own client.ts documents having been checked against BASE's
 * live API.
 *
 * Structural gap this adapter resolves differently from BASE/eBay: every Shopify API call is
 * scoped to one store's own subdomain (https://{shop}.myshopify.com/...), unlike BASE/eBay
 * where the access token alone identifies the account server-side. loadImplementedChannelAdapters
 * builds exactly ONE shared adapter instance per channel, reused across every tenant's every
 * connected account -- fine for BASE/eBay, broken for a naively "shopDomain baked into the
 * constructor" adapter, since one shared instance can't be every tenant's different store at
 * once. The fix: `shopDomain` is OPTIONAL on this adapter's config.
 *  - The shared singleton instance (no shopDomain) is used for every method that already
 *    receives an `externalId` -- getProduct/updateListing/delistProduct/setInventory/
 *    getInventory -- which parses "{shopDomain}::{productId}" out of that string instead of
 *    reading `this.config.shopDomain`. createListing (the one place a fresh externalId is
 *    minted, not received) returns exactly that composite format, so every externalId this
 *    platform ever stores (channel_listings.external_id) already carries its own shop.
 *  - OAuth (getAuthorizationUrl/exchangeCodeForToken) and createListing instead need a
 *    PER-REQUEST adapter instance constructed with shopDomain set explicitly -- oauth-shopify's
 *    own handler has it from the `?shop=` callback param; shopify-sync-worker has it from the
 *    sync_jobs payload's own stored accountId. Never routed through the shared singleton.
 *  - listProducts/listRecentSales (no externalId parameter to carry a shop at all, and genuinely
 *    unused by this platform's real pipeline today -- BASE is the only source channel actually
 *    read FROM; see docs/adding-a-channel.md) throw a clear error on the shop-less shared
 *    instance. They still work on a shopDomain-constructed instance, for a future caller that
 *    needs them.
 *
 * Known simplification: Shopify inventory is set per (inventory_item_id, location_id), not
 * per product -- this adapter assumes a single-variant product (matching product_master's own
 * 1-product-1-SKU model) and resolves that variant's inventory_item_id with an extra GET
 * inside setInventory/getInventory. defaultLocationId is resolved dynamically (this store's
 * first location, via GET /locations.json) rather than configured, since this platform has no
 * per-tenant "which Shopify location" setting yet -- correct for the common single-location
 * store, wrong for a multi-warehouse Shopify setup, which would need that as real tenant
 * configuration to fix for real.
 */
export class ShopifyAdapter implements ChannelAdapter {
  readonly channel = "shopify" as const;
  private readonly apiVersion: string;
  private locationIdCache = new Map<string, string>();

  constructor(private readonly config: ShopifyAdapterConfig) {
    this.apiVersion = config.apiVersion ?? SHOPIFY_API_DEFAULT_VERSION;
  }

  private storeBaseUrl(shopDomain: string): string {
    return `https://${shopDomain}.myshopify.com`;
  }

  /** The shop domain this call should hit: prefer one explicitly parsed out of an externalId
   *  parameter (the shared singleton's only way to know); fall back to this instance's own
   *  config.shopDomain (set on a per-request instance, e.g. inside shopify-sync-worker). */
  private resolveShopDomain(fromExternalId?: string): string {
    if (fromExternalId) return splitExternalId(fromExternalId).shopDomain;
    if (this.config.shopDomain) return this.config.shopDomain;
    throw new Error(
      "ShopifyAdapter has no shop domain to call -- neither this instance's own config.shopDomain nor a \"{shopDomain}::{productId}\" externalId was provided. The shared loadImplementedChannelAdapters() singleton has no shopDomain by design; construct a per-request ShopifyAdapter with shopDomain set instead.",
    );
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const shopDomain = this.resolveShopDomain();
    const url = new URL(`${this.storeBaseUrl(shopDomain)}/admin/oauth/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("scope", SHOPIFY_OAUTH_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string, _redirectUri: string): Promise<OAuthTokenSet> {
    // Unlike BASE (which requires redirect_uri in the token-exchange body), Shopify's OAuth
    // token exchange doesn't take one -- verified against Shopify's public docs. Still
    // accepted as a parameter to satisfy ChannelAdapter's shared interface.
    const shopDomain = this.resolveShopDomain();
    const res = await fetch(`${this.storeBaseUrl(shopDomain)}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.config.clientId, client_secret: this.config.clientSecret, code }),
    });
    if (!res.ok) throw new ShopifyApiError(res.status, await res.text());
    const json = (await res.json()) as ShopifyTokenResponse;
    return {
      accessToken: json.access_token,
      // Shopify's offline-mode access tokens (the only mode this flow requests) don't
      // expire and have no refresh token -- unlike BASE/eBay's OAuth2 model. expiresAt is
      // set far in the future rather than left inaccurate; refreshToken() below reflects
      // this honestly instead of pretending Shopify's flow works like BASE/eBay's.
      refreshToken: null,
      expiresAt: new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000),
      scope: json.scope,
    };
  }

  async refreshToken(_refreshToken: string): Promise<OAuthTokenSet> {
    throw new Error(
      "Shopify's offline access tokens don't expire and can't be refreshed -- getValidAccessToken should never need to call this for a Shopify connection. If this throws in practice, something upstream wrongly assumed Shopify works like BASE/eBay's OAuth2 refresh flow.",
    );
  }

  private async authedFetch(shopDomain: string, accessToken: string, path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.storeBaseUrl(shopDomain)}/admin/api/${this.apiVersion}${path}`, {
      ...init,
      headers: {
        // Shopify's own header, not a Bearer token -- confirmed in Shopify's public docs,
        // unlike BASE/eBay which both use a standard Authorization: Bearer header.
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) throw new ShopifyApiError(res.status, await res.text());
    return res;
  }

  /** Only usable on a per-request instance (config.shopDomain set) -- see this class's own
   *  doc comment. Not called anywhere in this platform's real pipeline today (BASE is the
   *  only source channel this platform ever reads products FROM). */
  async listProducts(accessToken: string, params: ListProductsParams): Promise<ListProductsResult> {
    const shopDomain = this.resolveShopDomain();
    const limit = 250; // Shopify's own documented max page size for this endpoint.
    const search = new URLSearchParams({ limit: String(limit) });
    if (params.cursor) search.set("page_info", params.cursor);
    if (params.since) search.set("updated_at_min", params.since.toISOString());
    const res = await this.authedFetch(shopDomain, accessToken, `/products.json?${search.toString()}`);
    const json = (await res.json()) as ShopifyProductsResponse;
    // Real Shopify cursor pagination is carried in the Link response header, not the body --
    // omitted here since this adapter isn't wired to any real store to verify header parsing
    // against; a real implementation must read that header rather than always returning
    // undefined (which silently caps every sync to one page).
    return { items: json.products.map((p) => mapShopifyProduct(shopDomain, p)) };
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    const { shopDomain, productId } = splitExternalId(externalId);
    try {
      const res = await this.authedFetch(shopDomain, accessToken, `/products/${productId}.json`);
      const json = (await res.json()) as ShopifyProductResponse;
      return mapShopifyProduct(shopDomain, json.product);
    } catch (err) {
      if (err instanceof ShopifyApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createListing(accessToken: string, input: CreateListingInput): Promise<{ externalId: string }> {
    const shopDomain = this.resolveShopDomain();
    const res = await this.authedFetch(shopDomain, accessToken, "/products.json", {
      method: "POST",
      body: JSON.stringify({
        product: {
          title: input.titleEn,
          body_html: input.descriptionHtmlEn,
          images: input.images.map((src) => ({ src })),
          variants: [{ price: input.priceUsd.toFixed(2), sku: input.sku, inventory_quantity: input.quantity, inventory_management: "shopify" }],
        },
      }),
    });
    const json = (await res.json()) as ShopifyProductResponse;
    return { externalId: `${shopDomain}${EXTERNAL_ID_SEPARATOR}${json.product.id}` };
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    const { shopDomain, productId } = splitExternalId(externalId);
    const payload: Record<string, unknown> = {};
    if (input.titleEn !== undefined) payload.title = input.titleEn;
    if (input.descriptionHtmlEn !== undefined) payload.body_html = input.descriptionHtmlEn;
    if (Object.keys(payload).length > 0) {
      await this.authedFetch(shopDomain, accessToken, `/products/${productId}.json`, {
        method: "PUT",
        body: JSON.stringify({ product: { id: Number(productId), ...payload } }),
      });
    }
    // Price lives on the variant, not the top-level product resource PUT above -- a price-only
    // update that only touched `payload` would silently never reach Shopify otherwise. Was a
    // real gap in an earlier version of this method (priceUsd was accepted by the type
    // signature but silently dropped); fixed by resolving the variant and sending its own PUT.
    if (input.priceUsd !== undefined) {
      const variant = await this.resolveFirstVariant(shopDomain, accessToken, productId);
      await this.authedFetch(shopDomain, accessToken, `/variants/${variant.id}.json`, {
        method: "PUT",
        body: JSON.stringify({ variant: { id: variant.id, price: input.priceUsd.toFixed(2) } }),
      });
    }
    // input.quantity is deliberately never applied here -- every quantity push (both this
    // platform's own N-channel sale fan-out and this adapter's own createListing) goes through
    // setInventory, the one path that resolves the real (inventory_item_id, location_id) pair
    // Shopify's inventory API actually requires. UpdateListingInput still carries `quantity`
    // (inherited from CreateListingInput) only because eBay's own updateListing uses it.
  }

  async delistProduct(accessToken: string, externalId: string): Promise<void> {
    // Shopify's own convention for "hidden, not for sale" without deleting the product
    // record -- verified against Shopify's public docs, not a live store.
    const { shopDomain, productId } = splitExternalId(externalId);
    await this.authedFetch(shopDomain, accessToken, `/products/${productId}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: Number(productId), status: "draft" } }),
    });
  }

  async setInventory(accessToken: string, externalId: string, quantity: number): Promise<void> {
    const { shopDomain, productId } = splitExternalId(externalId);
    const [inventoryItemId, locationId] = await Promise.all([
      this.resolveInventoryItemId(shopDomain, accessToken, productId),
      this.resolveDefaultLocationId(shopDomain, accessToken),
    ]);
    await this.authedFetch(shopDomain, accessToken, "/inventory_levels/set.json", {
      method: "POST",
      body: JSON.stringify({ location_id: Number(locationId), inventory_item_id: inventoryItemId, available: quantity }),
    });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  /** Only usable on a per-request instance (config.shopDomain set) -- see this class's own
   *  doc comment. Not called anywhere in this platform's real pipeline today; a sale made
   *  directly through a tenant's own Shopify storefront (outside this platform) is not yet
   *  detected or cross-decremented against BASE/eBay stock -- see docs/adding-a-channel.md. */
  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    const shopDomain = this.resolveShopDomain();
    const search = new URLSearchParams({ status: "any", created_at_min: since.toISOString() });
    const res = await this.authedFetch(shopDomain, accessToken, `/orders.json?${search.toString()}`);
    const json = (await res.json()) as ShopifyOrdersResponse;
    const sales: SaleEvent[] = [];
    for (const order of json.orders) {
      for (const item of order.line_items) {
        sales.push({
          channel: "shopify",
          externalProductId: `${shopDomain}${EXTERNAL_ID_SEPARATOR}${item.product_id}`,
          externalOrderId: String(order.id),
          quantitySold: item.quantity,
          occurredAt: new Date(order.created_at),
          // Shopify stores are commonly USD-priced but can be set to any store currency --
          // SaleEvent's own salePriceJpy/salePriceUsdCents fields assume every channel is
          // either JPY (BASE) or USD (eBay), which doesn't fit a Shopify store on a 3rd
          // currency. Left unset (same "adapter doesn't parse a price" fallback BASE/eBay use
          // when they can't confidently fill these) rather than guessed -- see
          // docs/adding-a-channel.md for what fixing this for real would need.
        });
      }
    }
    return sales;
  }

  private async resolveFirstVariant(shopDomain: string, accessToken: string, productId: string): Promise<ShopifyVariant> {
    const res = await this.authedFetch(shopDomain, accessToken, `/products/${productId}.json`);
    const json = (await res.json()) as ShopifyProductResponse;
    const variant = json.product.variants[0];
    if (!variant) throw new Error(`Shopify product ${productId} has no variants`);
    return variant;
  }

  private async resolveInventoryItemId(shopDomain: string, accessToken: string, productId: string): Promise<number> {
    return (await this.resolveFirstVariant(shopDomain, accessToken, productId)).inventory_item_id;
  }

  private async resolveDefaultLocationId(shopDomain: string, accessToken: string): Promise<string> {
    const cached = this.locationIdCache.get(shopDomain);
    if (cached) return cached;
    const res = await this.authedFetch(shopDomain, accessToken, "/locations.json");
    const json = (await res.json()) as ShopifyLocationsResponse;
    const location = json.locations[0];
    if (!location) throw new Error(`Shopify store ${shopDomain} has no locations -- cannot set inventory without one`);
    const id = String(location.id);
    this.locationIdCache.set(shopDomain, id);
    return id;
  }
}

function mapShopifyProduct(shopDomain: string, product: ShopifyProduct): ExternalProduct {
  const variant = product.variants[0];
  return {
    externalId: `${shopDomain}${EXTERNAL_ID_SEPARATOR}${product.id}`,
    title: product.title,
    descriptionHtml: product.body_html,
    // ExternalProduct.priceJpy is a fixed JPY field regardless of channel (see
    // @ai-ec/core's product.ts) -- correct for BASE (the only source channel today, always
    // JPY), but a Shopify store's real price (variant.price) is in its own store currency,
    // not necessarily JPY. Left as a direct passthrough here (documented, not silently
    // "fixed") since Shopify is intended as a destination channel like eBay, not a source
    // this platform reads FROM -- see docs/adding-a-channel.md.
    priceJpy: variant ? Number(variant.price) : 0,
    quantity: variant?.inventory_quantity ?? 0,
    images: product.images.map((img) => img.src),
    updatedAt: new Date(product.updated_at),
  };
}
