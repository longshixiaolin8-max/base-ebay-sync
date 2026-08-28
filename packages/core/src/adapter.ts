import type { ChannelType } from "./channel.js";
import type { ExternalProduct, SaleEvent } from "./product.js";

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry; adapters must refresh proactively before this. */
  expiresAt: Date;
  scope: string | null;
}

export interface CreateListingInput {
  productId: string;
  titleEn: string;
  descriptionHtmlEn: string;
  priceUsd: number;
  quantity: number;
  images: string[];
  categoryId: string;
  itemSpecifics: Record<string, string | null>;
  sku: string;
}

export interface UpdateListingInput extends Partial<Omit<CreateListingInput, "productId" | "sku">> {}

export interface ListProductsParams {
  since?: Date;
  cursor?: string;
}

export interface ListProductsResult {
  items: ExternalProduct[];
  nextCursor?: string;
}

/**
 * Every sales channel (BASE, eBay, and — in the future — Shopify/Amazon/Rakuten) is
 * integrated purely by implementing this interface. Sync workers, the AI pipeline and
 * the admin UI depend only on ChannelAdapter, never on a specific channel's SDK/API
 * shape. This is what keeps BASE and eBay from ever talking to each other directly:
 * both are just adapters plugged into the same Product/Inventory Master.
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;

  getAuthorizationUrl(state: string, redirectUri: string): string;
  exchangeCodeForToken(code: string, redirectUri: string): Promise<OAuthTokenSet>;
  refreshToken(refreshToken: string): Promise<OAuthTokenSet>;

  listProducts(accessToken: string, params: ListProductsParams): Promise<ListProductsResult>;
  getProduct(accessToken: string, externalId: string): Promise<ExternalProduct | null>;

  createListing(accessToken: string, input: CreateListingInput): Promise<{ externalId: string }>;
  updateListing(
    accessToken: string,
    externalId: string,
    input: UpdateListingInput,
  ): Promise<void>;
  delistProduct(accessToken: string, externalId: string): Promise<void>;

  setInventory(accessToken: string, externalId: string, quantity: number): Promise<void>;
  getInventory(accessToken: string, externalId: string): Promise<number | null>;

  /** Sales that happened since `since`, used to detect "sold on this channel" events. */
  listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]>;
}
