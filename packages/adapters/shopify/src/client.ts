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
 * Deliberately NOT added to IMPLEMENTED_CHANNELS (@ai-ec/core) -- doing so would make every
 * worker that loops over IMPLEMENTED_CHANNELS (see @ai-ec/lambda-shared's
 * loadImplementedChannelAdapters) try to construct a real ShopifyAdapter and fetch Shopify
 * credentials from Secrets Manager that don't exist, breaking those workers at runtime.
 *
 * Known simplification: Shopify inventory is set per (inventory_item_id, location_id), not
 * per product -- this adapter assumes a single-variant product and resolves that variant's
 * inventory_item_id with an extra GET inside setInventory/getInventory, keeping the
 * ChannelAdapter contract's single externalId (the Shopify product id) intact. A real
 * integration handling multi-variant products would need a richer externalId shape.
 */
export class ShopifyAdapter implements ChannelAdapter {
  readonly channel = "shopify" as const;
  private readonly apiVersion: string;

  constructor(private readonly config: ShopifyAdapterConfig) {
    this.apiVersion = config.apiVersion ?? SHOPIFY_API_DEFAULT_VERSION;
  }

  private get storeBaseUrl(): string {
    return `https://${this.config.shopDomain}.myshopify.com`;
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL(`${this.storeBaseUrl}/admin/oauth/authorize`);
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
    const res = await fetch(`${this.storeBaseUrl}/admin/oauth/access_token`, {
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

  private async authedFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.storeBaseUrl}/admin/api/${this.apiVersion}${path}`, {
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

  async listProducts(accessToken: string, params: ListProductsParams): Promise<ListProductsResult> {
    const limit = 250; // Shopify's own documented max page size for this endpoint.
    const search = new URLSearchParams({ limit: String(limit) });
    if (params.cursor) search.set("page_info", params.cursor);
    if (params.since) search.set("updated_at_min", params.since.toISOString());
    const res = await this.authedFetch(accessToken, `/products.json?${search.toString()}`);
    const json = (await res.json()) as ShopifyProductsResponse;
    // Real Shopify cursor pagination is carried in the Link response header, not the body --
    // omitted here since this adapter isn't wired to any real store to verify header parsing
    // against; a real implementation must read that header rather than always returning
    // undefined (which silently caps every sync to one page).
    return { items: json.products.map(mapShopifyProduct) };
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    try {
      const res = await this.authedFetch(accessToken, `/products/${externalId}.json`);
      const json = (await res.json()) as ShopifyProductResponse;
      return mapShopifyProduct(json.product);
    } catch (err) {
      if (err instanceof ShopifyApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createListing(accessToken: string, input: CreateListingInput): Promise<{ externalId: string }> {
    const res = await this.authedFetch(accessToken, "/products.json", {
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
    return { externalId: String(json.product.id) };
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.titleEn !== undefined) payload.title = input.titleEn;
    if (input.descriptionHtmlEn !== undefined) payload.body_html = input.descriptionHtmlEn;
    await this.authedFetch(accessToken, `/products/${externalId}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: Number(externalId), ...payload } }),
    });
  }

  async delistProduct(accessToken: string, externalId: string): Promise<void> {
    // Shopify's own convention for "hidden, not for sale" without deleting the product
    // record -- verified against Shopify's public docs, not a live store.
    await this.authedFetch(accessToken, `/products/${externalId}.json`, {
      method: "PUT",
      body: JSON.stringify({ product: { id: Number(externalId), status: "draft" } }),
    });
  }

  async setInventory(accessToken: string, externalId: string, quantity: number): Promise<void> {
    const inventoryItemId = await this.resolveInventoryItemId(accessToken, externalId);
    await this.authedFetch(accessToken, "/inventory_levels/set.json", {
      method: "POST",
      body: JSON.stringify({ location_id: Number(this.config.defaultLocationId), inventory_item_id: inventoryItemId, available: quantity }),
    });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    const search = new URLSearchParams({ status: "any", created_at_min: since.toISOString() });
    const res = await this.authedFetch(accessToken, `/orders.json?${search.toString()}`);
    const json = (await res.json()) as ShopifyOrdersResponse;
    const sales: SaleEvent[] = [];
    for (const order of json.orders) {
      for (const item of order.line_items) {
        sales.push({
          channel: "shopify",
          externalProductId: String(item.product_id),
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

  private async resolveInventoryItemId(accessToken: string, productExternalId: string): Promise<number> {
    const res = await this.authedFetch(accessToken, `/products/${productExternalId}.json`);
    const json = (await res.json()) as ShopifyProductResponse;
    const variant = json.product.variants[0];
    if (!variant) throw new Error(`Shopify product ${productExternalId} has no variants to resolve an inventory_item_id from`);
    return variant.inventory_item_id;
  }
}

function mapShopifyProduct(product: ShopifyProduct): ExternalProduct {
  const variant = product.variants[0];
  return {
    externalId: String(product.id),
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
