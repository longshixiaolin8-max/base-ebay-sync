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
import type { EbayPublicKey } from "./notification.js";

interface EbayTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface EbayInventoryItem {
  sku: string;
  product: { title: string; description: string; imageUrls: string[]; aspects?: Record<string, string[]> };
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
 * Item #3 of the second hardening round ("自動ロールバック -- 誤同期した場合、直前の
 * 正常状態へ自動復元"). updateListing() makes two independent eBay API calls (the
 * inventory_item content PUT, then a separate offer price PUT) -- if the first succeeds
 * and the second fails, the live listing is left showing a new title/condition/quantity
 * next to a stale price, a real inconsistency a buyer could see. When that happens,
 * updateListing() reverts the content PUT back to what it was a moment before (the exact
 * state it already fetched to build the update) and throws this instead of the raw error,
 * so the caller knows a rollback happened and can record it -- the update still counts as
 * failed and flows through the normal sync_errors/retry path either way.
 */
export class EbayPartialUpdateRolledBackError extends Error {
  constructor(readonly cause: Error) {
    super(`eBay listing update partially applied then rolled back to its prior state: ${cause.message}`);
    this.name = "EbayPartialUpdateRolledBackError";
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

  /** Lists real eBay Notification API topics (id, description, filterable) — used to find the
   * correct topicId to subscribe to instead of guessing one. */
  async listNotificationTopics(appAccessToken: string): Promise<unknown> {
    const res = await fetch(`${this.apiBaseUrl}/commerce/notification/v1/topic?limit=100`, {
      headers: { Authorization: `Bearer ${appAccessToken}` },
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    return res.json();
  }

  /**
   * One-time account-level setup required before any destination/subscription call will
   * succeed (eBay rejects those with errorId 195003 "Please provide configurations required
   * for notifications" until this is set).
   */
  async updateNotificationConfig(appAccessToken: string, alertEmail: string): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}/commerce/notification/v1/config`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${appAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ alertEmail }),
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
  }

  /**
   * One-time webhook onboarding step: registers our endpoint with eBay. eBay immediately
   * sends a GET ?challenge_code=... to the endpoint to verify ownership before this call
   * returns, so the endpoint must already be deployed and able to answer it.
   */
  async createNotificationDestination(
    appAccessToken: string,
    name: string,
    endpoint: string,
    verificationToken: string,
  ): Promise<{ destinationId: string }> {
    const res = await fetch(`${this.apiBaseUrl}/commerce/notification/v1/destination`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        status: "ENABLED",
        deliveryConfig: {
          endpoint,
          verificationToken,
          deliveryProtocol: "HTTPS",
          payloadVersion: "1.0",
        },
      }),
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const location = res.headers.get("Location");
    const destinationId = location?.split("/").pop();
    if (!destinationId) throw new Error("eBay createNotificationDestination did not return a destination id");
    return { destinationId };
  }

  async createNotificationSubscription(
    appAccessToken: string,
    topicId: string,
    destinationId: string,
  ): Promise<{ subscriptionId: string }> {
    const res = await fetch(`${this.apiBaseUrl}/commerce/notification/v1/subscription`, {
      method: "POST",
      headers: { Authorization: `Bearer ${appAccessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topicId, destinationId, status: "ENABLED", payload: { format: "JSON", schemaVersion: "1.0" } }),
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const location = res.headers.get("Location");
    const subscriptionId = location?.split("/").pop();
    if (!subscriptionId) throw new Error("eBay createNotificationSubscription did not return a subscription id");
    return { subscriptionId };
  }

  /** Fetches the public key used to verify an inbound notification's X-EBAY-SIGNATURE header. */
  async getNotificationPublicKey(appAccessToken: string, keyId: string): Promise<EbayPublicKey> {
    const res = await fetch(`${this.apiBaseUrl}/commerce/notification/v1/public_key/${keyId}`, {
      headers: { Authorization: `Bearer ${appAccessToken}` },
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    return res.json() as Promise<EbayPublicKey>;
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

  /**
   * Real, per-category required item-specifics (eBay's own "Item Specifics" requirements),
   * used to verify an AI-drafted listing's aspects are actually publishable before spending
   * a publish attempt on it, instead of only discovering a missing one from a live 400.
   */
  async getRequiredItemAspects(appAccessToken: string, categoryId: string): Promise<string[]> {
    const res = await fetch(
      `${this.apiBaseUrl}/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=${encodeURIComponent(categoryId)}`,
      { headers: { Authorization: `Bearer ${appAccessToken}` } },
    );
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const json = (await res.json()) as {
      aspects?: Array<{ localizedAspectName: string; aspectConstraint?: { aspectRequired?: boolean } }>;
    };
    return (json.aspects ?? []).filter((a) => a.aspectConstraint?.aspectRequired).map((a) => a.localizedAspectName);
  }

  /**
   * Real, per-category allowed condition values (eBay's Sell Metadata API) -- some
   * categories (e.g. fine jewelry) only support a subset of the generic ConditionEnum,
   * and publishing an unsupported one fails with errorId 25059. Never guess; verify.
   */
  async getConditionPolicies(
    appAccessToken: string,
    categoryId: string,
  ): Promise<Array<{ conditionId: string; conditionDescription: string }>> {
    const marketplaceId = this.config.marketplaceId ?? "EBAY_US";
    const res = await fetch(
      `${this.apiBaseUrl}/sell/metadata/v1/marketplace/${marketplaceId}/get_item_condition_policies?filter=categoryIds:{${encodeURIComponent(categoryId)}}`,
      { headers: { Authorization: `Bearer ${appAccessToken}` } },
    );
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const json = (await res.json()) as {
      itemConditionPolicies?: Array<{
        itemConditions?: Array<{ conditionId: string; conditionDescription: string }>;
      }>;
    };
    return json.itemConditionPolicies?.[0]?.itemConditions ?? [];
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
        "Accept-Language": "en-US",
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

  /** Raw inventory_item payload (aspects included) — useful for debugging category-required-aspect errors. */
  async getRawInventoryItem(accessToken: string, sku: string): Promise<unknown> {
    const res = await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${sku}`);
    return res.json();
  }

  /** Raw offer payload (includes the public listingId once published) for a given SKU. */
  async getRawOffer(accessToken: string, sku: string): Promise<unknown> {
    const res = await this.authedFetch(accessToken, `/sell/inventory/v1/offer?sku=${sku}`);
    return res.json();
  }

  async createListing(accessToken: string, input: CreateListingInput): Promise<{ externalId: string }> {
    await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${input.sku}`, {
      method: "PUT",
      body: JSON.stringify({
        availability: { shipToLocationAvailability: { quantity: input.quantity } },
        condition: input.condition,
        product: {
          title: input.titleEn,
          description: input.descriptionHtmlEn,
          imageUrls: input.images,
          aspects: toAspects(input.itemSpecifics),
        },
      }),
    });

    const offerBody = {
      sku: input.sku,
      marketplaceId: this.config.marketplaceId ?? "EBAY_US",
      format: "FIXED_PRICE",
      categoryId: input.categoryId,
      listingDescription: input.descriptionHtmlEn,
      pricingSummary: { price: { value: input.priceUsd.toFixed(2), currency: "USD" } },
      merchantLocationKey: this.config.merchantLocationKey,
      listingPolicies: {
        fulfillmentPolicyId: this.config.fulfillmentPolicyId,
        paymentPolicyId: this.config.paymentPolicyId,
        returnPolicyId: this.config.returnPolicyId,
      },
    };

    // A prior attempt (e.g. one that failed at the publish step) may have already created
    // the offer for this SKU — eBay rejects a second POST with "Offer entity already
    // exists", so reuse it via PUT instead of blindly creating a new one every retry.
    let offerId = await this.findOfferId(accessToken, input.sku);
    if (offerId) {
      await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offerId}`, {
        method: "PUT",
        body: JSON.stringify(offerBody),
      });
    } else {
      const offerRes = await this.authedFetch(accessToken, `/sell/inventory/v1/offer`, {
        method: "POST",
        body: JSON.stringify(offerBody),
      });
      ({ offerId } = (await offerRes.json()) as { offerId: string });
    }

    await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offerId}/publish`, {
      method: "POST",
    });

    return { externalId: input.sku };
  }

  async updateListing(accessToken: string, externalId: string, input: UpdateListingInput): Promise<void> {
    let contentPutApplied = false;
    let priorInventoryItemBody: Record<string, unknown> | undefined;

    if (
      input.titleEn !== undefined ||
      input.descriptionHtmlEn !== undefined ||
      input.images !== undefined ||
      input.quantity !== undefined ||
      input.condition !== undefined ||
      input.itemSpecifics !== undefined
    ) {
      // eBay's PUT inventory_item is a full replace, not a merge -- any field we omit is
      // cleared, not left as-is (confirmed live: an update that only touched quantity had
      // silently wiped the listing's required "Type" aspect, breaking republish with
      // errorId 25002). Fetch the raw current item so every field not explicitly being
      // changed here is carried over instead of dropped.
      const currentRes = await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`);
      const current = (await currentRes.json()) as EbayInventoryItem & { condition?: string };
      // The exact same body, but with every field defaulted to its pre-update value --
      // i.e. a full no-op restore of "current" -- kept in case the price PUT below fails
      // and this content half needs to be rolled back (see EbayPartialUpdateRolledBackError).
      priorInventoryItemBody = {
        availability: {
          shipToLocationAvailability: { quantity: current.availability?.shipToLocationAvailability?.quantity ?? 0 },
        },
        condition: current.condition,
        product: {
          title: current.product?.title,
          description: current.product?.description,
          imageUrls: current.product?.imageUrls,
          aspects: current.product?.aspects,
        },
      };
      await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`, {
        method: "PUT",
        body: JSON.stringify({
          availability: {
            shipToLocationAvailability: {
              quantity: input.quantity ?? current.availability?.shipToLocationAvailability?.quantity ?? 0,
            },
          },
          condition: input.condition ?? current.condition,
          product: {
            title: input.titleEn ?? current.product?.title,
            description: input.descriptionHtmlEn ?? current.product?.description,
            imageUrls: input.images ?? current.product?.imageUrls,
            aspects: input.itemSpecifics ? toAspects(input.itemSpecifics) : current.product?.aspects,
          },
        }),
      });
      contentPutApplied = true;
    }

    if (input.priceUsd !== undefined) {
      try {
        const offerId = await this.findOfferId(accessToken, externalId);
        if (offerId) {
          await this.authedFetch(accessToken, `/sell/inventory/v1/offer/${offerId}`, {
            method: "PUT",
            body: JSON.stringify({
              pricingSummary: { price: { value: input.priceUsd.toFixed(2), currency: "USD" } },
            }),
          });
        }
      } catch (err) {
        if (!contentPutApplied || !priorInventoryItemBody) throw err; // nothing was applied, nothing to roll back
        await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`, {
          method: "PUT",
          body: JSON.stringify(priorInventoryItemBody),
        });
        throw new EbayPartialUpdateRolledBackError(err as Error);
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

  /**
   * One-time seller onboarding step: opts the account into eBay's Business Policy
   * management, required before fulfillment/payment/return policies can be created.
   * Safe to call again if already opted in (eBay returns an error we ignore).
   */
  async optInToBusinessPolicies(accessToken: string): Promise<void> {
    const res = await fetch(`${this.apiBaseUrl}/sell/account/v1/program/opt_in`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ programType: "SELLING_POLICY_MANAGEMENT" }),
    });
    if (!res.ok && res.status !== 409) throw new EbayApiError(res.status, await res.text());
  }

  async createFulfillmentPolicy(accessToken: string, name: string): Promise<string> {
    const res = await this.authedFetch(accessToken, `/sell/account/v1/fulfillment_policy`, {
      method: "POST",
      body: JSON.stringify({
        name,
        marketplaceId: this.config.marketplaceId ?? "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        handlingTime: { value: 3, unit: "DAY" },
        shippingOptions: [
          {
            optionType: "DOMESTIC",
            costType: "FLAT_RATE",
            shippingServices: [
              {
                sortOrder: 1,
                shippingCarrierCode: "USPS",
                shippingServiceCode: "USPSPriority",
                shippingCost: { value: "15.00", currency: "USD" },
              },
            ],
          },
        ],
      }),
    });
    const json = (await res.json()) as { fulfillmentPolicyId: string };
    return json.fulfillmentPolicyId;
  }

  async createPaymentPolicy(accessToken: string, name: string): Promise<string> {
    const res = await this.authedFetch(accessToken, `/sell/account/v1/payment_policy`, {
      method: "POST",
      body: JSON.stringify({
        name,
        marketplaceId: this.config.marketplaceId ?? "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        immediatePay: false,
      }),
    });
    const json = (await res.json()) as { paymentPolicyId: string };
    return json.paymentPolicyId;
  }

  async createReturnPolicy(accessToken: string, name: string): Promise<string> {
    const res = await this.authedFetch(accessToken, `/sell/account/v1/return_policy`, {
      method: "POST",
      body: JSON.stringify({
        name,
        marketplaceId: this.config.marketplaceId ?? "EBAY_US",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        returnsAccepted: true,
        returnPeriod: { value: 30, unit: "DAY" },
        refundMethod: "MONEY_BACK",
        returnShippingCostPayer: "BUYER",
      }),
    });
    const json = (await res.json()) as { returnPolicyId: string };
    return json.returnPolicyId;
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
