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

/**
 * BASE's real /1/items response has no "images" array and no "updated" field — verified
 * against a live production item. Photos come as up to 20 flat img1_origin..img20_origin
 * fields (absent/null for unused slots), and the modification time is "modified", a Unix
 * epoch in seconds.
 */
const BASE_IMAGE_SLOT_COUNT = 20;

interface BaseItem {
  item_id: string;
  title: string;
  detail: string;
  price: number;
  stock: number;
  modified: number;
  [imgSlot: `img${number}_origin`]: string | null | undefined;
}

interface BaseItemsResponse {
  items: BaseItem[];
  offset: number;
  limit: number;
}

/**
 * BASE's real GET /1/orders (list) response has NO order_items at all -- verified against
 * BASE's own gist-hosted reference (gist.github.com/baseinc/9760824). `ordered` is a Unix
 * timestamp in seconds, same convention as items' `modified` field above.
 */
interface BaseOrderSummary {
  unique_key: string;
  ordered: number;
}
interface BaseOrdersResponse {
  orders: BaseOrderSummary[];
}

/**
 * GET /1/orders/detail/:unique_key is where order_items (with real per-item pricing)
 * actually lives -- verified against BASE's own reference
 * (gist.github.com/baseinc/9930892). `item_id`/`total` are JSON numbers there, not strings.
 */
interface BaseOrderDetailItem {
  item_id: number;
  amount: number;
  /** price * amount, in whole JPY (BASE has no minor currency unit). */
  total: number;
}
interface BaseOrderDetail {
  unique_key: string;
  ordered: number;
  order_items: BaseOrderDetailItem[];
}
interface BaseOrderDetailResponse {
  order: BaseOrderDetail;
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
    // Verified against BASE's official reference (docs.thebase.in/api/oauth/authorize):
    // response_type=code and redirect_uri (the OAuth-standard name) are both required.
    // scope must be space-separated using BASE's real scope names (see config.ts).
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", BASE_OAUTH_SCOPES.join(" "));
    url.searchParams.set("state", state);
    return url.toString();
  }

  async exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenSet> {
    return this.requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
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
      .filter((item) => !params.since || new Date(item.modified * 1000) >= params.since)
      .map(mapBaseItem);
    return {
      items,
      nextCursor: json.items.length === limit ? String(offset + limit) : undefined,
    };
  }

  async getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null> {
    // item_id is a path segment here, not a query param -- verified against BASE's own
    // reference (docs.thebase.in/docs/api/items/detail): GET /1/items/detail/:item_id.
    const res = await this.authedFetch(accessToken, `/1/items/detail/${externalId}`);
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
    // BASE's own reference wants "yyyy-mm-dd hh:mm:ss", not full ISO 8601 -- but its
    // timezone is undocumented anywhere found, so this is only a best-effort server-side
    // prefilter (assuming JST, a Japan-only API); the client-side filter below against each
    // order's own unambiguous Unix `ordered` timestamp is what actually guarantees
    // correctness regardless of whether that assumption holds -- the same defense-in-depth
    // pattern listProducts already uses for `modified` above.
    const search = new URLSearchParams({ start_ordered: formatBaseDateTimeJst(since) });
    const res = await this.authedFetch(accessToken, `/1/orders?${search.toString()}`);
    const json = (await res.json()) as BaseOrdersResponse;
    const recentOrders = json.orders.filter((order) => new Date(order.ordered * 1000) >= since);

    // The list response has no order_items (see BaseOrderSummary above) -- same
    // "list is thin, detail has the real data" shape already established for items
    // (getProduct), so each order needs its own detail call.
    const sales: SaleEvent[] = [];
    for (const orderSummary of recentOrders) {
      const detailRes = await this.authedFetch(accessToken, `/1/orders/detail/${orderSummary.unique_key}`);
      const { order } = (await detailRes.json()) as BaseOrderDetailResponse;
      for (const item of order.order_items) {
        sales.push({
          channel: "base",
          externalProductId: String(item.item_id),
          externalOrderId: order.unique_key,
          quantitySold: item.amount,
          occurredAt: new Date(order.ordered * 1000),
          salePriceJpy: item.total,
        });
      }
    }
    return sales;
  }
}

function formatBaseDateTimeJst(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}:${pad(jst.getUTCSeconds())}`;
}

function extractImages(item: BaseItem): string[] {
  const images: string[] = [];
  for (let i = 1; i <= BASE_IMAGE_SLOT_COUNT; i++) {
    const url = item[`img${i}_origin`];
    if (url) images.push(url);
  }
  return images;
}

function mapBaseItem(item: BaseItem): ExternalProduct {
  return {
    externalId: item.item_id,
    title: item.title,
    descriptionHtml: item.detail,
    priceJpy: item.price,
    quantity: item.stock,
    images: extractImages(item),
    updatedAt: new Date(item.modified * 1000),
  };
}
