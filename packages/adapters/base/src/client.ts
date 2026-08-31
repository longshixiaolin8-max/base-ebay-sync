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
import { BASE_API_DEFAULT_HOST, BASE_OAUTH_SCOPES, type BaseAdapterConfig } from "./config.js";

interface BaseTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

interface BaseItem {
  item_id: string;
  title: string;
  detail: string;
  price: number;
  stock: number;
  images: Array<{ url: string }>;
  updated: string;
}

interface BaseItemsResponse {
  items: BaseItem[];
  offset: number;
  limit: number;
}

interface BaseOrderItem {
  item_id: string;
  amount: number;
}
interface BaseOrder {
  ordered_id: string;
  ordered: string;
  order_items: BaseOrderItem[];
}
interface BaseOrdersResponse {
  orders: BaseOrder[];
}

class BaseApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`BASE API error ${status}: ${body}`);
    this.name = "BaseApiError";
  }
}

/**
 * ChannelAdapter implementation for BASE (https://thebase.in).
 *
 * Endpoint paths follow BASE's public REST API (api.thebase.in/1/*, OAuth2 authorization
 * code flow). Field names should be re-verified against the current BASE API reference
 * before production use — this client centralizes all of BASE's HTTP shape behind the
 * ChannelAdapter interface, so any wording drift only needs a fix in this one file.
 */
export class BaseAdapter implements ChannelAdapter {
  readonly channel = "base" as const;
  private readonly apiBaseUrl: string;

  constructor(private readonly config: BaseAdapterConfig) {
    this.apiBaseUrl = config.apiBaseUrl ?? BASE_API_DEFAULT_HOST;
  }

  getAuthorizationUrl(state: string, redirectUri: string): string {
    const url = new URL(`${this.apiBaseUrl}/1/oauth/authorize`);
    // BASE's authorize endpoint does not take "response_type" — real working examples
    // only ever show client_id/redirect_url/scope(/state). Sending an extra unrecognized
    // param appears to trip BASE's strict validation ("invalid_request: 不正なパラメーターです").
    url.searchParams.set("client_id", this.config.clientId);
    // BASE's API uses the non-standard "redirect_url" param name (not the OAuth-standard
    // "redirect_uri") — confirmed against real integration write-ups; sending "redirect_uri"
    // causes BASE's server to ignore it and misroute the consent redirect entirely.
    url.searchParams.set("redirect_url", redirectUri);
    url.searchParams.set("scope", BASE_OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    return this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_url: redirectUri,
    });
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenSet> {
    return this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  private async requestToken(extra: Record<string, string>): Promise<OAuthTokenSet> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      ...extra,
    });
    const res = await fetch(`${this.apiBaseUrl}/1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) throw new BaseApiError(res.status, await res.text());
    const json = (await res.json()) as BaseTokenResponse;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: json.scope ?? null,
    };
  }

  private async authedFetch(accessToken: string, path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) throw new BaseApiError(res.status, await res.text());
    return res;
  }

  async listProducts(accessToken: string, params: ListProductsParams): Promise<ListProductsResult> {
    const limit = 100;
    const offset = params.cursor ? Number(params.cursor) : 0;
    const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    const res = await this.authedFetch(accessToken, `/1/items?${search.toString()}`);
    const json = (await res.json()) as BaseItemsResponse;
    const items = json.items
      .filter((item) => !params.since || new Date(item.updated) >= params.since)
      .map(mapBaseItem);
    return {
      items,
      nextCursor: json.items.length === limit ? String(offset + limit) : undefined,
    };
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    const res = await this.authedFetch(accessToken, `/1/items/detail?item_id=${externalId}`);
    const json = (await res.json()) as { item: BaseItem | null };
    return json.item ? mapBaseItem(json.item) : null;
  }

  /**
   * BASE is the source of truth for its own listings — this platform reads and reflects
   * BASE product changes into eBay, but never auto-creates or deletes a BASE listing.
   */
  async createListing(_accessToken: string, _input: CreateListingInput): Promise<{ externalId: string }> {
    throw new Error(
      "createListing is not supported for the BASE channel: products originate in BASE, not from this platform",
    );
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    const payload: Record<string, unknown> = {};
    if (input.titleEn !== undefined) payload.title = input.titleEn;
    if (input.priceUsd !== undefined) payload.price = input.priceUsd;
    await this.authedFetch(accessToken, `/1/items/edit`, {
      method: "POST",
      body: JSON.stringify({ item_id: externalId, ...payload }),
    });
  }

  async delistProduct(accessToken: string, externalId: string): Promise<void> {
    await this.authedFetch(accessToken, `/1/items/edit`, {
      method: "POST",
      body: JSON.stringify({ item_id: externalId, visible: 0 }),
    });
  }

  async setInventory(accessToken: string, externalId: string, quantity: number): Promise<void> {
    await this.authedFetch(accessToken, `/1/items/edit`, {
      method: "POST",
      body: JSON.stringify({ item_id: externalId, stock: quantity }),
    });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    const search = new URLSearchParams({ start_ordered: since.toISOString() });
    const res = await this.authedFetch(accessToken, `/1/orders?${search.toString()}`);
    const json = (await res.json()) as BaseOrdersResponse;
    return json.orders.flatMap((order) =>
      order.order_items.map((orderItem) => ({
        channel: "base" as const,
        externalProductId: orderItem.item_id,
        externalOrderId: order.ordered_id,
        quantitySold: orderItem.amount,
        occurredAt: new Date(order.ordered),
      })),
    );
  }
}

function mapBaseItem(item: BaseItem): ExternalProduct {
  return {
    externalId: item.item_id,
    title: item.title,
    descriptionHtml: item.detail,
    priceJpy: item.price,
    quantity: item.stock,
    images: item.images.map((i) => i.url),
    updatedAt: new Date(item.updated),
  };
}
