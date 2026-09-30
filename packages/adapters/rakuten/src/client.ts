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
import { RAKUTEN_RMS_API_DEFAULT_HOST, type RakutenAdapterConfig } from "./config.js";

interface RakutenItem {
  itemUrl: string;
  itemName: string;
  itemPrice: number;
  inventoryCount: number;
  images?: { imageUrl: string }[];
  updateTimestamp?: string;
}

interface RakutenOrder {
  orderNumber: string;
  orderDatetime: string;
  packages: { itemDetails: { itemNumber: string; itemName: string; units: number; price: number }[] }[];
}

class RakutenApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Rakuten RMS API error ${status}: ${body}`);
    this.name = "RakutenApiError";
  }
}

/**
 * ChannelAdapter implementation for Rakuten Ichiba (楽天市場), against RMS
 * (Rakuten Merchant Server) API 2.0 -- same scaffold disclosure as
 * @ai-ec/adapter-shopify/@ai-ec/adapter-amazon: compiles, typechecks, unit-tested against
 * mocked responses, **never run against a real RMS-registered shop**.
 *
 * Confidence note, more important here than for Shopify/Amazon: this codebase's training data
 * has much thinner public coverage of RMS API 2.0's exact JSON field names than it does of
 * Shopify's or Amazon SP-API's very heavily documented public APIs. Treat every field name in
 * this file as a best-effort placeholder, not a verified shape -- re-check against Rakuten's
 * own RMS API reference (documented inside the RMS merchant control panel, not fully public)
 * even more carefully than the other scaffolds before using this for anything real.
 *
 * One thing that IS confidently real and worth designing around from the start: RMS's classic
 * API auth is **not an OAuth2 authorization-code redirect flow** like BASE/eBay/Shopify/Amazon.
 * A Rakuten shop owner generates their own "ライセンスキー" (license key) inside the RMS
 * control panel and hands it to the connecting application directly -- there is no
 * "authorize on Rakuten's site, get redirected back with a code" step at all. That means:
 *   - getAuthorizationUrl/exchangeCodeForToken/refreshToken all throw here rather than fake a
 *     redirect flow that doesn't exist for this channel.
 *   - The per-tenant secret this platform already stores as an opaque "access token" (via
 *     oauth_connections + getValidAccessToken, same slot BASE/eBay's real OAuth tokens use)
 *     should simply BE the tenant's own license key for Rakuten -- every other method here
 *     (listProducts, setInventory, ...) takes that same accessToken parameter and treats it as
 *     the license key, which fits this codebase's existing storage plumbing without a schema
 *     change.
 *   - The admin UI's "再接続" button (which opens an OAuth authorize URL in a new tab for
 *     every other channel) has no equivalent for Rakuten -- connecting/reconnecting Rakuten
 *     needs its own UI: a form where the tenant pastes their license key, not a redirect.
 *     ConnectionsTab.tsx's current onReconnect always calls
 *     GET /admin/oauth/:channel/authorize-url, which would need a per-channel branch (or a
 *     different action entirely) once Rakuten is real. See docs/adding-a-channel.md.
 */
export class RakutenAdapter implements ChannelAdapter {
  readonly channel = "rakuten" as const;
  private readonly apiBaseUrl: string;

  constructor(private readonly config: RakutenAdapterConfig) {
    this.apiBaseUrl = config.apiBaseUrl ?? RAKUTEN_RMS_API_DEFAULT_HOST;
  }

  getAuthorizationUrl(): string {
    throw new Error(
      "Rakuten's RMS API has no OAuth authorize-URL redirect flow -- a shop's license key is generated manually in the RMS control panel and entered directly, not obtained via redirect. See this class's own doc comment.",
    );
  }

  async exchangeCodeForToken(): Promise<OAuthTokenSet> {
    throw new Error("Rakuten's RMS API has no authorization-code exchange -- see getAuthorizationUrl's error message and this class's own doc comment.");
  }

  async refreshToken(): Promise<OAuthTokenSet> {
    throw new Error("Rakuten's RMS license key doesn't expire/refresh the way an OAuth token does -- see this class's own doc comment.");
  }

  /** `accessToken` here is the tenant's own RMS license key -- see this class's doc comment. */
  private async authedFetch(licenseKey: string, path: string, init?: RequestInit): Promise<Response> {
    const auth = Buffer.from(`${this.config.serviceSecret}:${licenseKey}`).toString("base64");
    const res = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `ESA ${auth}`,
        "Content-Type": "application/json; charset=utf-8",
        ...init?.headers,
      },
    });
    if (!res.ok) throw new RakutenApiError(res.status, await res.text());
    return res;
  }

  async listProducts(licenseKey: string, params: ListProductsParams): Promise<ListProductsResult> {
    const body: Record<string, unknown> = {};
    if (params.since) body.updateTimestampFrom = params.since.toISOString();
    if (params.cursor) body.cursor = params.cursor;
    const res = await this.authedFetch(licenseKey, "/es/2.0/items/search", { method: "POST", body: JSON.stringify(body) });
    const json = (await res.json()) as { items: RakutenItem[]; nextCursor?: string };
    return { items: json.items.map(mapRakutenItem), nextCursor: json.nextCursor };
  }

  async getProduct(licenseKey: string, externalId: string): Promise<ExternalProduct | null> {
    try {
      const res = await this.authedFetch(licenseKey, `/es/2.0/items/get?itemUrl=${encodeURIComponent(externalId)}`);
      return mapRakutenItem((await res.json()) as RakutenItem);
    } catch (err) {
      if (err instanceof RakutenApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** Same stance as BASE (see @ai-ec/adapter-base's own createListing): Rakuten is a
   *  source-of-truth storefront a seller manages directly in RMS, not a channel this
   *  platform auto-creates new listings on. */
  async createListing(_accessToken: string, _input: CreateListingInput): Promise<{ externalId: string }> {
    throw new Error("createListing is not supported for the Rakuten channel: listings originate in RMS, not from this platform");
  }

  async updateListing(licenseKey: string, externalId: string, input: UpdateListingInput): Promise<void> {
    const body: Record<string, unknown> = { itemUrl: externalId };
    if (input.titleEn !== undefined) body.itemName = input.titleEn;
    if (input.priceUsd !== undefined) body.itemPrice = input.priceUsd;
    await this.authedFetch(licenseKey, "/es/2.0/items/update", { method: "POST", body: JSON.stringify(body) });
  }

  async delistProduct(licenseKey: string, externalId: string): Promise<void> {
    await this.authedFetch(licenseKey, "/es/2.0/items/update", { method: "POST", body: JSON.stringify({ itemUrl: externalId, hideItem: true }) });
  }

  async setInventory(licenseKey: string, externalId: string, quantity: number): Promise<void> {
    await this.authedFetch(licenseKey, "/es/1.0/inventories/manage/update", {
      method: "POST",
      body: JSON.stringify({ itemUrl: externalId, inventoryCount: quantity }),
    });
  }

  async getInventory(licenseKey: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(licenseKey, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(licenseKey: string, since: Date): Promise<SaleEvent[]> {
    const res = await this.authedFetch(licenseKey, "/es/2.0/order/searchOrder", {
      method: "POST",
      body: JSON.stringify({ dateType: 1, startDatetime: since.toISOString() }),
    });
    const json = (await res.json()) as { orders: RakutenOrder[] };
    const sales: SaleEvent[] = [];
    for (const order of json.orders) {
      for (const pkg of order.packages) {
        for (const item of pkg.itemDetails) {
          sales.push({
            channel: "rakuten",
            externalProductId: item.itemNumber,
            externalOrderId: order.orderNumber,
            quantitySold: item.units,
            occurredAt: new Date(order.orderDatetime),
            salePriceJpy: item.price * item.units,
          });
        }
      }
    }
    return sales;
  }
}

function mapRakutenItem(item: RakutenItem): ExternalProduct {
  return {
    externalId: item.itemUrl,
    title: item.itemName,
    descriptionHtml: "",
    priceJpy: item.itemPrice,
    quantity: item.inventoryCount,
    images: item.images?.map((img) => img.imageUrl) ?? [],
    updatedAt: item.updateTimestamp ? new Date(item.updateTimestamp) : new Date(),
  };
}
