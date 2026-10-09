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
import { fetchWithRetry } from "@ai-ec/core";
import {
  EBAY_API_DEFAULT_HOST,
  EBAY_AUTH_DEFAULT_HOST,
  EBAY_IDENTITY_API_DEFAULT_HOST,
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

export interface EbayInventoryLocation {
  merchantLocationKey: string;
  merchantLocationStatus?: string;
  location?: { address?: EbayInventoryLocationAddress };
}

/**
 * Verified against an independently-generated eBay Fulfillment API SDK (not eBay's own
 * developer.ebay.com docs, which this environment's network policy blocks fetching directly
 * -- github.com/sam-ecomdev/ebay-fulfillment-api's LineItem/Amount models, themselves
 * generated from eBay's real OpenAPI spec): `total` is the buyer-paid amount for this line
 * item after any line-item-level discount, as an Amount{value, currency} pair.
 */
interface EbayAmount {
  value: string;
  currency: string;
}
interface EbayOrderLineItem {
  sku: string;
  quantity: number;
  total?: EbayAmount;
}
interface EbayOrder {
  orderId: string;
  creationDate: string;
  lineItems: EbayOrderLineItem[];
}
interface EbayOrdersResponse {
  orders: EbayOrder[];
  /** Pagination metadata returned by Fulfillment getOrders. */
  total?: number;
  limit?: number;
  offset?: number;
  next?: string;
}

/**
 * eBay's error payload bundles a human-readable message with, for some errors (confirmed
 * live on errorId 25002/SELLING_PRIVILEGE_REQUIRED), a `parameters` array that embeds the
 * exact URL the seller needs to visit to resolve it -- e.g. "You need to create a seller's
 * account" plus "https://ebaypayonboardingweb.ebay.com/seller-reg?client=THIRD_PARTY_API".
 * Without this, that actionable detail was buried in a raw JSON blob only visible by
 * querying the database directly; no seller using this platform could self-serve it.
 */
function parseEbayErrorDetail(body: string): { userMessage: string; actionUrl?: string } | null {
  let parsed: { errors?: Array<{ message?: string; longMessage?: string; parameters?: Array<{ value?: string }> }> };
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const first = parsed.errors?.[0];
  const userMessage = first?.longMessage ?? first?.message;
  if (!userMessage) return null;
  const actionUrl = first?.parameters?.map((p) => p.value).find((v) => typeof v === "string" && /^https?:\/\//.test(v));
  return { userMessage, actionUrl };
}

export class EbayApiError extends Error {
  /** eBay's own human-readable message for this error, when its body parses as eBay's error JSON shape. */
  readonly userMessage?: string;
  /** A URL eBay's error parameters point the seller to, when the error includes one (e.g. seller-registration flows). */
  readonly actionUrl?: string;

  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`eBay API error ${status}: ${body}`);
    this.name = "EbayApiError";
    const detail = parseEbayErrorDetail(body);
    this.userMessage = detail?.userMessage;
    this.actionUrl = detail?.actionUrl;
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
  private readonly identityApiBaseUrl: string;

  constructor(private readonly config: EbayAdapterConfig) {
    this.apiBaseUrl = config.apiBaseUrl ?? EBAY_API_DEFAULT_HOST;
    this.authBaseUrl = config.authBaseUrl ?? EBAY_AUTH_DEFAULT_HOST;
    this.identityApiBaseUrl = config.identityApiBaseUrl ?? EBAY_IDENTITY_API_DEFAULT_HOST;
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

  /**
   * The tenant-isolation fix that replaced oauth-{base,ebay}'s "default" externalAccountId
   * fallback: eBay's Commerce Identity API (GET {identityApiBaseUrl}/commerce/identity/v1/user/,
   * requires the commerce.identity.readonly scope on the USER's own access token, not an app
   * token) returns this account's immutable userId -- unlike username, it never changes even
   * if the seller renames their eBay account, which is exactly what oauth_connections needs
   * as a stable primary key, and it's also what eBay's own MARKETPLACE_ACCOUNT_DELETION
   * notification payload identifies the account by (see ebay-webhook's handleAccountDeletion).
   * Note the distinct apiz.* host -- this is the one eBay REST call this adapter makes that
   * is NOT served from this.apiBaseUrl.
   */
  async getAuthenticatedUserId(accessToken: string): Promise<string> {
    const res = await fetchWithRetry(`${this.identityApiBaseUrl}/commerce/identity/v1/user/`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    const body = (await res.json()) as { userId?: string };
    if (!body.userId) {
      throw new EbayApiError(res.status, "eBay Identity API response had no userId field");
    }
    return body.userId;
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenSet> {
    const refreshed = await this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: EBAY_OAUTH_SCOPES.join(" "),
    });
    // eBay's refresh_token grant response never includes a new refresh_token -- unlike
    // the authorization_code grant, it only ever returns a fresh access_token/expires_in.
    // eBay's refresh tokens are long-lived (~18 months) and intentionally not rotated on
    // every access-token renewal. requestToken() maps a response with no refresh_token
    // field to `null` (correct for the initial authorization_code exchange, where a
    // missing refresh_token really would mean none was issued) -- but here it would
    // silently overwrite the real, still-valid refresh token with null on every renewal,
    // permanently breaking auto-refresh after exactly one cycle and forcing a full manual
    // re-authorization every time the access token next expired.
    return { ...refreshed, refreshToken: refreshed.refreshToken ?? refreshToken };
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/commerce/notification/v1/topic?limit=100`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/commerce/notification/v1/config`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/commerce/notification/v1/destination`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/commerce/notification/v1/subscription`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/commerce/notification/v1/public_key/${keyId}`, {
      headers: { Authorization: `Bearer ${appAccessToken}` },
    });
    if (!res.ok) throw new EbayApiError(res.status, await res.text());
    return res.json() as Promise<EbayPublicKey>;
  }

  /**
   * Subscribes this seller's connected eBay account to Platform Notifications (the legacy
   * Trading API's push-notification system, distinct from -- and older than -- the REST
   * Commerce Notification API used by createNotificationDestination/Subscription above) for
   * the FixedPriceTransaction event: eBay pushes a notification the moment a buyer completes
   * a fixed-price purchase, rather than this app having to poll for it.
   *
   * Requires this application's App ID to be allow-listed by eBay for OAuth-based Platform
   * Notifications delivery (the X-EBAY-API-IAF-TOKEN header below) -- see
   * https://developer.ebay.com/api-docs/static/oauth-trad-apis.html. Without that
   * whitelisting, eBay rejects this call; request it via Developer Technical Support first.
   *
   * X-EBAY-API-COMPATIBILITY-LEVEL: pinned to a version confirmed to accept this call as of
   * this writing -- re-verify against developer.ebay.com/api-docs/user-guides before raising
   * it, since a too-old value can also be rejected once eBay retires support for it.
   */
  async subscribeToFixedPriceTransactionNotifications(
    userAccessToken: string,
    endpointUrl: string,
    alertEmail: string,
  ): Promise<void> {
    const body = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<SetNotificationPreferencesRequest xmlns="urn:ebay:apis:eBLBaseComponents">',
      "  <ApplicationDeliveryPreferences>",
      "    <ApplicationEnable>Enable</ApplicationEnable>",
      `    <ApplicationURL>${escapeXml(endpointUrl)}</ApplicationURL>`,
      "    <AlertEnable>Enable</AlertEnable>",
      `    <AlertEmail>mailto://${escapeXml(alertEmail)}</AlertEmail>`,
      "    <DeviceType>Platform</DeviceType>",
      "  </ApplicationDeliveryPreferences>",
      "  <UserDeliveryPreferenceArray>",
      "    <NotificationEnable>",
      "      <EventType>FixedPriceTransaction</EventType>",
      "      <EventEnable>Enable</EventEnable>",
      "    </NotificationEnable>",
      "  </UserDeliveryPreferenceArray>",
      "</SetNotificationPreferencesRequest>",
    ].join("\n");

    const res = await fetchWithRetry(`${this.apiBaseUrl}/ws/api.dll`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
        "X-EBAY-API-CALL-NAME": "SetNotificationPreferences",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-IAF-TOKEN": userAccessToken,
      },
      body,
    });
    const text = await res.text();
    if (!res.ok || /<Ack>Failure<\/Ack>/.test(text)) {
      throw new EbayApiError(res.status, text);
    }
  }

  /**
   * Looks up real eBay category IDs for a free-text query via the Taxonomy API, so category
   * selection is a verified lookup rather than a guessed number.
   */
  async suggestCategories(
    appAccessToken: string,
    query: string,
  ): Promise<Array<{ ebayCategoryId: string; label: string }>> {
    const res = await fetchWithRetry(
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
    const res = await fetchWithRetry(
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
    const res = await fetchWithRetry(
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/identity/v1/oauth2/token`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}${path}`, {
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
    const res = await fetchWithRetry(`${this.apiBaseUrl}/sell/inventory/v1/inventory_item/${externalId}`, {
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

  /**
   * Diagnostic-only: runs the same inventory_item/offer lookups createListing() does, but
   * never throws on a non-2xx response -- captures the status and body of each step instead,
   * so a "why won't this SKU publish" investigation can see exactly which eBay call is
   * failing and with what, rather than only the first error swallowing the rest.
   */
  async debugOfferState(accessToken: string, sku: string): Promise<Record<string, unknown>> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    };
    const step = async (path: string) => {
      const res = await fetchWithRetry(`${this.apiBaseUrl}${path}`, { headers });
      const body = await res.text();
      return { status: res.status, body };
    };
    return {
      inventoryItem: await step(`/sell/inventory/v1/inventory_item/${sku}`),
      offersBySku: await step(`/sell/inventory/v1/offer?sku=${sku}`),
    };
  }

  /**
   * Diagnostic-only: eBay's own Account API answer for "what's actually missing" behind a
   * SELLING_PRIVILEGE_REQUIRED (errorId 25002) block, which Seller Hub's task list can show
   * as fully complete while the Third-Party API listing path still rejects every publish.
   * Never throws on a non-2xx -- a seller who isn't even in the payments program for this
   * marketplace gets a 404 here, which is itself diagnostic information, not a failure.
   */
  async getPaymentsProgramOnboarding(
    accessToken: string,
    paymentsProgramType = "EBAY_PAYMENTS",
  ): Promise<Record<string, unknown>> {
    const marketplaceId = this.config.marketplaceId ?? "EBAY_US";
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Content-Language": "en-US",
      "Accept-Language": "en-US",
    };
    const res = await fetchWithRetry(
      `${this.apiBaseUrl}/sell/account/v1/payments_program/${marketplaceId}/payments_program/${paymentsProgramType}`,
      { headers },
    );
    const body = await res.text();
    return { marketplaceId, paymentsProgramType, status: res.status, body };
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

  /**
   * eBay's Inventory API has no PATCH on inventory_item -- only GET, PUT
   * (createOrReplaceInventoryItem), and DELETE (confirmed against eBay's own current API
   * reference; there is no partial-update method for this resource). PUT is a full
   * replace, not a merge -- any field omitted from the body is cleared, not left as-is
   * (confirmed live: an update that only touched quantity had silently wiped the listing's
   * required "Type" aspect, breaking republish with errorId 25002). So every write to this
   * resource -- setInventory included, which used to send a bare PATCH the real API would
   * reject -- goes through this same fetch-current-then-full-replace path, changing only
   * the fields actually passed in `overrides`.
   *
   * Returns the exact pre-update body (a full no-op restore of what was just overwritten),
   * so a caller than also modifies the offer's price afterward (see updateListing) can roll
   * this content half back if that second call fails.
   */
  private async replaceInventoryItemPreservingFields(
    accessToken: string,
    externalId: string,
    overrides: {
      quantity?: number;
      condition?: string;
      titleEn?: string;
      descriptionHtmlEn?: string;
      images?: string[];
      itemSpecifics?: Record<string, string | null>;
    },
  ): Promise<{ priorBody: Record<string, unknown> }> {
    const currentRes = await this.authedFetch(accessToken, `/sell/inventory/v1/inventory_item/${externalId}`);
    const current = (await currentRes.json()) as EbayInventoryItem & { condition?: string };
    const priorBody = {
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
            quantity: overrides.quantity ?? current.availability?.shipToLocationAvailability?.quantity ?? 0,
          },
        },
        condition: overrides.condition ?? current.condition,
        product: {
          title: overrides.titleEn ?? current.product?.title,
          description: overrides.descriptionHtmlEn ?? current.product?.description,
          imageUrls: overrides.images ?? current.product?.imageUrls,
          aspects: overrides.itemSpecifics ? toAspects(overrides.itemSpecifics) : current.product?.aspects,
        },
      }),
    });
    return { priorBody };
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
      const { priorBody } = await this.replaceInventoryItemPreservingFields(accessToken, externalId, {
        quantity: input.quantity,
        condition: input.condition,
        titleEn: input.titleEn,
        descriptionHtmlEn: input.descriptionHtmlEn,
        images: input.images,
        itemSpecifics: input.itemSpecifics,
      });
      priorInventoryItemBody = priorBody;
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
    await this.replaceInventoryItemPreservingFields(accessToken, externalId, { quantity });
  }

  async getInventory(accessToken: string, externalId: string): Promise<number | null> {
    const product = await this.getProduct(accessToken, externalId);
    return product?.quantity ?? null;
  }

  async listRecentSales(accessToken: string, since: Date): Promise<SaleEvent[]> {
    // Fulfillment getOrders uses offset pagination. eBay raised the documented maximum
    // page size to 200 (Fulfillment API 1.19.10), so use that maximum to minimise API
    // calls while still exhausting every page. The API may return `total` and `next`;
    // we use `total` when present and fall back to page fullness for defensive
    // compatibility with older/simplified responses (including Sandbox fixtures).
    const pageLimit = 200;
    const maxPages = 100; // safety guard: at most 20,000 orders in one poll invocation
    const filter = encodeURIComponent(`creationdate:[${since.toISOString()}..]`);
    const seenOrderIds = new Set<string>();
    const orders: EbayOrder[] = [];
    let offset = 0;

    for (let page = 0; page < maxPages; page += 1) {
      const res = await this.authedFetch(
        accessToken,
        `/sell/fulfillment/v1/order?filter=${filter}&limit=${pageLimit}&offset=${offset}`,
      );
      const json = (await res.json()) as EbayOrdersResponse;
      const pageOrders = json.orders ?? [];

      for (const order of pageOrders) {
        if (seenOrderIds.has(order.orderId)) continue;
        seenOrderIds.add(order.orderId);
        orders.push(order);
      }

      const responseOffset = Number.isFinite(json.offset) ? Number(json.offset) : offset;
      const responseLimit = Number.isFinite(json.limit) && Number(json.limit) > 0 ? Number(json.limit) : pageLimit;
      const nextOffset = responseOffset + responseLimit;

      // Prefer eBay's total count when supplied. If it is absent, a short page is the
      // standard end-of-collection signal. `next` is advisory only; offset remains the
      // source of truth so we never follow an unexpected cross-host URL.
      if (typeof json.total === "number") {
        if (nextOffset >= json.total) break;
      } else if (!json.next && pageOrders.length < responseLimit) {
        break;
      }

      if (nextOffset <= offset) {
        throw new Error("eBay getOrders pagination did not advance the offset");
      }
      offset = nextOffset;

      if (page === maxPages - 1) {
        throw new Error(`eBay getOrders pagination exceeded safety limit of ${maxPages} pages`);
      }
    }

    return orders.flatMap((order) =>
      order.lineItems.map((lineItem) => {
        // USD is this platform's only supported eBay marketplace currency today (see
        // pricing.ts) -- a line item settled in another currency is left unpriced here
        // rather than silently treated as USD.
        const salePriceUsdCents =
          lineItem.total && lineItem.total.currency === "USD"
            ? Math.round(Number(lineItem.total.value) * 100)
            : undefined;
        return {
          channel: "ebay" as const,
          externalProductId: lineItem.sku,
          externalOrderId: order.orderId,
          quantitySold: lineItem.quantity,
          occurredAt: new Date(order.creationDate),
          salePriceUsdCents,
        };
      }),
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
   * Lists ship-from locations already registered on this eBay seller account --
   * confirmed live: a seller who set theirs up directly in eBay's own Seller Hub (rather
   * than through this platform's onboarding) already has one, and re-asking them for an
   * address to create a *second* one would just produce a duplicate. Callers should prefer
   * reusing an existing ENABLED location's key over creating a new one.
   */
  async listInventoryLocations(accessToken: string): Promise<EbayInventoryLocation[]> {
    const res = await this.authedFetch(accessToken, `/sell/inventory/v1/location?limit=100`);
    const json = (await res.json()) as { locations?: EbayInventoryLocation[] };
    return json.locations ?? [];
  }

  /**
   * One-time seller onboarding step: opts the account into eBay's Business Policy
   * management, required before fulfillment/payment/return policies can be created.
   * Safe to call again if already opted in (eBay returns an error we ignore).
   */
  async optInToBusinessPolicies(accessToken: string): Promise<void> {
    const res = await fetchWithRetry(`${this.apiBaseUrl}/sell/account/v1/program/opt_in`, {
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
    try {
      const res = await this.authedFetch(accessToken, `/sell/inventory/v1/offer?sku=${sku}`);
      const json = (await res.json()) as EbayOffersResponse;
      return json.offers[0]?.offerId ?? null;
    } catch (err) {
      // Confirmed live: eBay's own getOffers call returns a bare 404 ("This Offer is not
      // available.", errorId 25713) for a SKU that has never had an offer created, not a
      // 200 with an empty offers array as its own docs imply. Every caller here treats a
      // null return as "no offer yet, go create one" -- without this, a brand-new SKU's
      // very first publish attempt crashed here before it ever reached the create-offer
      // step, every single time.
      if (err instanceof EbayApiError && err.status === 404) return null;
      throw err;
    }
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
