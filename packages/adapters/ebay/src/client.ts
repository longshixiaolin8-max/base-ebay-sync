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
import {
  EBAY_API_DEFAULT_HOST,
  EBAY_AUTH_DEFAULT_HOST,
  EBAY_OAUTH_SCOPES,
  type EbayAdapterConfig,
} from "./config.js";

interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface EbayInventoryItem {
  sku: string;
  product: { title: string; description: string; imageUrls: string[] };
  availability: { shipToLocationAvailability: { quantity: number } };
}

interface EbayOffer {
  offerId: string;
  sku: string;
}
interface EbayOffersResponse {
  offers: EbayOffer[];
}

export interface EbayInventoryLocationAddress {
  addressLine1: string;
  addressLine2?: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  country: string;
}

interface EbayOrderLineItem {
  sku: string;
  quantity: number;
}
interface EbayOrder {
  orderId: string;
  creationDate: string;
  lineItems: EbayOrderLineItem[];
}
interface EbayOrdersResponse {
  orders: EbayOrder[];
}

class EbayApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`eBay API error ${status}: ${body}`);
    this.name = "EbayApiError";
  }
}

/**
 * ChannelAdapter implementation for eBay, built on the Sell Inventory API
 * (inventory_item + offer + publish) and the Sell Fulfillment API (orders).
 *
 * We use our own SKU (ProductMaster.sku) as both the eBay inventory item SKU and as
 * ChannelListing.externalId — eBay's inventory items are addressed by merchant SKU, so
 * this avoids an extra lookup for every quantity/description update. Price changes go
 * through the associated offerId, which is looked up by SKU when needed.
 *
 * Endpoint paths follow eBay's public REST API docs; re-verify field names against the
 * current reference (developer.ebay.com/api-docs/sell/inventory) before production use.
 */
export class EbayAdapter implements ChannelAdapter {
  readonly channel = "ebay" as const;
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl: string;

  constructor(private readonly config: EbayAdapterConfig) {
    this.apiBaseUrl = config.apiBaseUrl ?? EBAY_API_DEFAULT_HOST;
    this.authBaseUrl = config.authBaseUrl ?? EBAY_AUTH_DEFAULT_HOST;
  }

  getAuthorizationUrl(state: string, _redirectUri: string): string {
    const url = new URL(`${this.authBaseUrl}/oauth2/authorize`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", this.config.ruName);
    url.searchParams.set("scope", EBAY_OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string): Promise<OAuthTokenSet> {
    return this.requestToken({ grant_type: "authorization_code", code, redirect_uri: this.config.ruName });
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenSet> {
    return this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: EBAY_OAUTH_SCOPES.join(" "),
    });
  }

  /**
   * App-level token (client_credentials grant) for eBay APIs that don't act on behalf of a
   * connected seller, such as Taxonomy category lookups. No user OAuth connection required.
   */
  async getApplicationAccessToken(): Promise<string> {
    const { accessToken } = await this.requestToken({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    });
    return accessToken;
  }

  /**
   * Looks up real eBay category IDs for a free-text query via the Taxonomy API, so category
   * selection is a verified lookup rather than a guessed number.
   */
  async suggestCategories(
    appAccessToken: string,
    query: string,
  ): Promise<Array<{ ebayCategoryId: string; label: string }>> {
    const res = await fetch(
      `${this.apiBaseUrl}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${appAccessToken}` } },
    );
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const json = (await res.json()) as {
      categorySuggestions?: Array<{ category: { categoryId: string; categoryName: string } }>;
    };
    return (json.categorySuggestions ?? []).map((s) => ({
      ebayCategoryId: s.category.categoryId,
      label: s.category.categoryName,
    }));
  }

  private async requestToken(extra: Record<string, string>): Promise<OAuthTokenSet> {
    const basicAuth = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const body = new URLSearchParams(extra);
    const res = await fetch(`${this.apiBaseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth}`,
      },
      body,
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const json = (await res.json()) as EbayTokenResponse;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: EBAY_OAUTH_SCOPES.join(" "),
    };
  }

  private async authedFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Content-Language": "en-US",
        ...init?.headers,
      },
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    return res;
  }

  async listProducts(accessToken: string, params: ListProductsParams): Promise<ListProductsResult> {
    const limit = 100;
    const offset = params.cursor ? Number(params.cursor) : 0;
    const res = await this.authedFetch(
      accessToken,
      `/sell/inventory/v1/inventory_item?limit=${limit}&offset=${offset}`,
    );
    const json = (await res.json()) as { inventoryItems: EbayInventoryItem[] };
    return {
      items: json.inventoryItems.map(mapEbayInventoryItem),
      nextCursor: json.inventoryItems.length === limit ? String(offset + limit) : undefined,
    };
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    const res = await fetch(`${this.apiBaseUrl}/sell/inventory/v1/inventory_item/${externalId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    return mapEbayInventoryItem((await res.json()) as EbayInventoryItem);
  }

  async createListing(accessToken: string, input: CreateListingInput): Promise<{ externalId: string }> {
    await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${input.sku}`, {
      method: "PUT",
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity: input.quantity } },
        condition: "NEW",
        product: {
          title: input.titleEn,
          description: input.descriptionHtmlEn,
          imageUrls: input.images,
          aspects: toAspects(input.itemSpecifics),
        },
      }),
    });

    const offerRes = await this.authedFetch(accessToken, `/sell/inventory/v1/offer`, {
      method: "POST",
      body: JSON.stringify({
        sku: input.sku,
        marketplaceId: this.config.marketplaceId ?? "EBAY_US",
        format: "FIXED_PRICE",
        categoryId: input.categoryId,
        listingDescription: input.descriptionHtmlEn,
        pricingSummary: { price: { value: input.priceUsd.toFixed(2), currency: "USD" } },
        merchantLocationKey: this.config.merchantLocationKey,
      }),
    });
    const offer = (await offerRes.json()) as { offerId: string };

    await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offer.offerId}/publish`, {
      method: "POST",
    });

    return { externalId: input.sku };
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    if (input.titleEn !== undefined || input.descriptionHtmlEn !== undefined || input.images !== undefined) {
      const current = await this.getProduct(accessToken, externalId);
      await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`, {
        method: "PUT",
        body: JSON.stringify({
          availability: {
            shipToLocationAvailability: { quantity: input.quantity ?? current?.quantity ?? 0 },
          },
          condition: "NEW",
          product: {
            title: input.titleEn ?? current?.title,
            description: input.descriptionHtmlEn ?? current?.descriptionHtml,
            imageUrls: input.images ?? current?.images,
            aspects: input.itemSpecifics ? toAspects(input.itemSpecifics) : undefined,
          },
        }),
      });
    }

    if (input.priceUsd !== undefined) {
      const offerId = await this.findOfferId(accessToken, externalId);
      if (offerId) {
        await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offerId}`, {
          method: "PUT",
          body: JSON.stringify({
            pricingSummary: { price: { value: input.priceUsd.toFixed(2), currency: "USD" } },
          }),
        });
      }
    }
  }

  async delistProduct(accessToken: string, externalId: string): Promise<void> {
    const offerId = await this.findOfferId(accessToken, externalId);
    if (offerId) {
      await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offerId}/withdraw`, { method: "POST" });
    }
  }

  async setInventory(accessToken: string, externalId: string, quantity: number): Promise<void> {
    await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`, {
      method: "PATCH",
      body: JSON.stringify({ availability: { shipToLocationAvailability: { quantity } } }),
    });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    const filter = encodeURIComponent(`creationdate:[${since.toISOString()}..]`);
    const res = await this.authedFetch(accessToken, `/sell/fulfillment/v1/order?filter=${filter}`);
    const json = (await res.json()) as EbayOrdersResponse;
    return json.orders.flatMap((order) =>
      order.lineItems.map((lineItem) => ({
        channel: "ebay" as const,
        externalProductId: lineItem.sku,
        externalOrderId: order.orderId,
        quantitySold: lineItem.quantity,
        occurredAt: new Date(order.creationDate),
      })),
    );
  }

  /**
   * One-time seller onboarding step: registers the ship-from location that offers
   * reference via merchantLocationKey. Must exist before createListing can publish.
   */
  async createInventoryLocation(
    accessToken: string,
    merchantLocationKey: string,
    address: EbayInventoryLocationAddress,
  ): Promise<void> {
    await this.authedFetch(accessToken, `/sell/inventory/v1/location/${merchantLocationKey}`, {
      method: "POST",
      body: JSON.stringify({
        location: { address },
        locationTypes: ["WAREHOUSE"],
        merchantLocationStatus: "ENABLED",
      }),
    });
  }

  private async findOfferId(accessToken: string, sku: string): Promise<string | null> {
    const res = await this.authedFetch(accessToken, `/sell/inventory/v1/offer?sku=${sku}`);
    const json = (await res.json()) as EbayOffersResponse;
    return json.offers[0]?.offerId ?? null;
  }
}

function mapEbayInventoryItem(item: EbayInventoryItem): ExternalProduct {
  return {
    externalId: item.sku,
    title: item.product.title,
    descriptionHtml: item.product.description,
    priceJpy: 0, // eBay does not track JPY; price lives on the offer in USD, not on the item.
    quantity: item.availability.shipToLocationAvailability.quantity,
    images: item.product.imageUrls,
    updatedAt: new Date(),
  };
}

function toAspects(itemSpecifics: Record<string, string | null>): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(itemSpecifics)) {
    if (value !== null) aspects[key] = [value];
  }
  return aspects;
}
