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
import { AMAZON_LWA_TOKEN_URL, AMAZON_SPAPI_DEFAULT_REGION, AMAZON_SPAPI_HOST_BY_REGION, AMAZON_SPAPI_ROLES, type AmazonAdapterConfig } from "./config.js";

interface AmazonLwaTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

interface AmazonListingsSummary {
  marketplaceId: string;
  itemName: string;
  productType: string;
}
interface AmazonFulfillmentAvailability {
  fulfillmentChannelCode: string;
  quantity: number;
}
interface AmazonListingsItem {
  sku: string;
  summaries: AmazonListingsSummary[];
  attributes: {
    fulfillment_availability?: AmazonFulfillmentAvailability[];
    list_price?: { value: number }[];
    main_product_image_locator?: { media_location: string }[];
  };
}

interface AmazonOrderItem {
  ASIN: string;
  SellerSKU: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string; CurrencyCode: string };
}
interface AmazonOrder {
  AmazonOrderId: string;
  PurchaseDate: string;
}

class AmazonApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Amazon SP-API error ${status}: ${body}`);
    this.name = "AmazonApiError";
  }
}

/**
 * ChannelAdapter implementation for Amazon's Selling Partner API (SP-API,
 * developer-docs.amazon.com/sp-api) -- written against Amazon's publicly documented API shape
 * as a template, following the same disclosure as @ai-ec/adapter-shopify: it compiles,
 * typechecks and has unit tests against mocked HTTP responses, but has **never been run
 * against a real registered SP-API application or seller account** -- this environment has
 * neither. Deliberately NOT added to IMPLEMENTED_CHANNELS for the same reason (see
 * docs/adding-a-channel.md).
 *
 * Two things make Amazon's real integration meaningfully different from BASE/eBay/Shopify,
 * both documented here rather than silently glossed over:
 *
 * 1. **The OAuth redirect doesn't hand back a generic "code"** -- Amazon's seller-authorization
 *    consent screen redirects with `spapi_oauth_code` and `selling_partner_id` query params,
 *    not an OAuth-standard `code`. Whatever calls exchangeCodeForToken(code, redirectUri) must
 *    pass `spapi_oauth_code` as `code`, and separately capture `selling_partner_id` -- see
 *    point 2.
 * 2. **Every Listings/Orders API call needs a per-seller `sellerId`
 *    (Amazon's `selling_partner_id`) as a URL path segment, not just an access token** -- unlike
 *    BASE (whose shop_id is resolved once via getAuthenticatedShopId and then implied by the
 *    access token's own scope on every later call). ChannelAdapter's shared interface has no
 *    parameter slot for this, and @ai-ec/lambda-shared's loadImplementedChannelAdapters()
 *    builds exactly one shared adapter instance reused across every tenant -- which doesn't
 *    work for a value that's genuinely different per tenant. A real integration needs either
 *    (a) a ChannelAdapter interface change threading an extra per-call identifier through
 *    every method, or (b) constructing a fresh AmazonAdapter per tenant at the call site
 *    (reading that tenant's own stored sellerId, e.g. from oauth_connections.externalAccountId)
 *    instead of using the shared factory. This adapter accepts sellerId in its constructor
 *    config as the simplest honest option, which means it is NOT drop-in compatible with
 *    loadImplementedChannelAdapters()'s "one shared instance" pattern as written today.
 *
 * SP-API's older mandatory AWS SigV4 request-signing requirement (on top of the LWA access
 * token) was retired by Amazon for standard operations around 2023 -- this client sends only
 * the LWA access token header, matching Amazon's current documented default. Re-verify this
 * against Amazon's current auth documentation before relying on it; a small number of
 * restricted-data operations (buyer PII) still need a separate Restricted Data Token, not
 * used by any method here.
 */
export class AmazonAdapter implements ChannelAdapter {
  readonly channel = "amazon" as const;
  private readonly apiBaseUrl: string;

  constructor(
    private readonly config: AmazonAdapterConfig & {
      /** See this file's own class doc, point 2, on why this can't live in a shared config
       *  the way clientId/clientSecret do. */
      sellerId: string;
    },
  ) {
    this.apiBaseUrl = AMAZON_SPAPI_HOST_BY_REGION[config.region ?? AMAZON_SPAPI_DEFAULT_REGION];
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL("https://sellercentral.amazon.com/apps/authorize/consent");
    url.searchParams.set("application_id", this.config.clientId);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    // `code` here must be the redirect's own `spapi_oauth_code` param -- see class doc point 1.
    return this.requestToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenSet> {
    return this.requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async requestToken(extra: Record<string, string>): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, ...extra });
    const res = await fetch(AMAZON_LWA_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new AmazonApiError(res.status, await res.text());
    const json = (await res.json()) as AmazonLwaTokenResponse;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: AMAZON_SPAPI_ROLES.join(" "),
    };
  }

  private async authedFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "x-amz-access-token": accessToken,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) throw new AmazonApiError(res.status, await res.text());
    return res;
  }

  async listProducts(_accessToken: string, _params: ListProductsParams): Promise<ListProductsResult> {
    // SP-API's Listings Items API is a per-SKU get/put, with no "list all my listings" call of
    // its own -- real integrations use the separate Reports API (a request/poll/download
    // 3-step flow for a bulk "GET_MERCHANT_LISTINGS_ALL_DATA" report) to enumerate SKUs, which
    // doesn't fit this adapter's single synchronous listProducts() call at all. Left
    // unimplemented rather than faked; see docs/adding-a-channel.md.
    throw new Error("listProducts is not implemented for Amazon -- see this method's own comment for why it doesn't map onto a single SP-API call");
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    try {
      const search = new URLSearchParams({ marketplaceIds: this.config.marketplaceId, includedData: "summaries,attributes" });
      const res = await this.authedFetch(accessToken, `/listings/2021-08-01/items/${this.config.sellerId}/${externalId}?${search.toString()}`);
      return mapAmazonListing(externalId, (await res.json()) as AmazonListingsItem);
    } catch (err) {
      if (err instanceof AmazonApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createListing(_accessToken: string, _input: CreateListingInput): Promise<{ externalId: string }> {
    // A real PUT /listings/2021-08-01/items/{sellerId}/{sku} body needs a `productType`
    // (e.g. "LUGGAGE", "SHOES") plus that product type's own Amazon-defined attribute schema
    // (fetched from the Product Type Definitions API) -- there's no single generic product
    // JSON shape the way BASE/eBay/Shopify each have. CreateListingInput's flat shape (title/
    // description/condition/itemSpecifics) doesn't carry a product type or Amazon's per-type
    // attribute names, so this can't be filled in honestly without guessing. See
    // docs/adding-a-channel.md.
    throw new Error("createListing is not implemented for Amazon -- see this method's own comment for the product-type-schema gap");
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    const patches: { op: "replace"; path: string; value: unknown }[] = [];
    if (input.priceUsd !== undefined) patches.push({ op: "replace", path: "/attributes/list_price", value: [{ value: input.priceUsd, currency: "USD" }] });
    if (input.quantity !== undefined) {
      patches.push({ op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: input.quantity }] });
    }
    await this.authedFetch(accessToken, `/listings/2021-08-01/items/${this.config.sellerId}/${externalId}?marketplaceIds=${this.config.marketplaceId}`, {
      method: "PATCH",
      body: JSON.stringify({ patches }),
    });
  }

  async delistProduct(accessToken: string, externalId: string): Promise<void> {
    await this.authedFetch(accessToken, `/listings/2021-08-01/items/${this.config.sellerId}/${externalId}?marketplaceIds=${this.config.marketplaceId}`, {
      method: "DELETE",
    });
  }

  async setInventory(accessToken: string, externalId: string, quantity: number): Promise<void> {
    await this.updateListing(accessToken, externalId, { quantity });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    const search = new URLSearchParams({ MarketplaceIds: this.config.marketplaceId, CreatedAfter: since.toISOString() });
    const res = await this.authedFetch(accessToken, `/orders/v0/orders?${search.toString()}`);
    const json = (await res.json()) as { payload: { Orders: AmazonOrder[] } };
    const sales: SaleEvent[] = [];
    for (const order of json.payload.Orders) {
      const itemsRes = await this.authedFetch(accessToken, `/orders/v0/orders/${order.AmazonOrderId}/orderItems`);
      const itemsJson = (await itemsRes.json()) as { payload: { OrderItems: AmazonOrderItem[] } };
      for (const item of itemsJson.payload.OrderItems) {
        sales.push({
          channel: "amazon",
          externalProductId: item.SellerSKU,
          externalOrderId: order.AmazonOrderId,
          quantitySold: item.QuantityOrdered,
          occurredAt: new Date(order.PurchaseDate),
          // Amazon.co.jp orders are JPY, amazon.com orders are USD -- SaleEvent's own
          // salePriceJpy/salePriceUsdCents fields assume the currency is implied by the
          // *channel*, which doesn't hold for a channel sold in multiple marketplace
          // currencies. Left unset rather than guessed off ItemPrice.CurrencyCode -- see
          // docs/adding-a-channel.md.
        });
      }
    }
    return sales;
  }
}

function mapAmazonListing(externalId: string, item: AmazonListingsItem): ExternalProduct {
  const summary = item.summaries[0];
  const availability = item.attributes.fulfillment_availability?.[0];
  const price = item.attributes.list_price?.[0];
  const image = item.attributes.main_product_image_locator?.[0];
  return {
    externalId,
    title: summary?.itemName ?? externalId,
    descriptionHtml: "",
    priceJpy: price?.value ?? 0,
    quantity: availability?.quantity ?? 0,
    images: image ? [image.media_location] : [],
    updatedAt: new Date(),
  };
}
