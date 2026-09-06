import { BaseAdapter } from "@ai-ec/adapter-base";
import type { EbayInventoryLocationAddress } from "@ai-ec/adapter-ebay";
import { createAIModelClient, generateSnsScript, suggestStaleProductImprovement } from "@ai-ec/ai";
import {
  classifyStaleness,
  computeDynamicPrice,
  DEFAULT_SHIPPING_USD,
  DEFAULT_TARGET_MARGIN_RATIO,
  ItemCondition,
  matchProductIdentity,
  OrderStatus,
  type ProductIdentityCandidate,
} from "@ai-ec/core";
import {
  aiListingDraft,
  applyReconstructedInventory,
  auditLog,
  channelListings,
  computeChannelSyncState,
  computeDynamicSafetyStock,
  computeSyncConfidence,
  finalizeOrderProfit,
  findStaleProducts,
  getInventoryBreakdown,
  getLiveOrderProfit,
  getSnsContent,
  InvalidOrderTransitionError,
  inventoryMaster,
  listOrders,
  listOrdersForProduct,
  markSnsStatus,
  orders,
  predictStockoutRisk,
  productMaster,
  reconstructInventory,
  syncErrors,
  syncJobs,
  traceSyncHistory,
  transitionOrderStatus,
  upsertSnsScript,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  enqueue,
  fetchFxRate,
  getAppCredentials,
  getApproximateMessageCount,
  getDb,
  getDlqUrls,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  requireEnv,
  signState,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const USD_PER_JPY_FALLBACK = 0.0067;

async function currentFxRate(): Promise<number> {
  try {
    return (await fetchFxRate()).fxRateUsdPerJpy;
  } catch {
    return USD_PER_JPY_FALLBACK;
  }
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function claimsFromEvent(event: APIGatewayProxyEventV2): Record<string, string> | undefined {
  return (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, string> } } }).authorizer
    ?.jwt?.claims;
}

/** Identity of the signed-in admin operator, as attached by the Cognito JWT authorizer. */
function actorFromEvent(event: APIGatewayProxyEventV2): string {
  const claims = claimsFromEvent(event);
  return claims?.email ?? claims?.sub ?? "unknown-admin";
}

export class MissingTenantClaimError extends Error {
  constructor() {
    super("Request is missing the custom:tenant_id claim");
    this.name = "MissingTenantClaimError";
  }
}

/**
 * Which tenant this request acts on. Fails closed (never falls back to any default tenant)
 * so a misconfigured Cognito user or a bug stripping the claim can never silently act as a
 * different tenant -- every route in this file relies on this, not a per-route judgment call.
 */
function tenantIdFromEvent(event: APIGatewayProxyEventV2): string {
  const tenantId = claimsFromEvent(event)?.["custom:tenant_id"];
  if (!tenantId) throw new MissingTenantClaimError();
  return tenantId;
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const db = getDb();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    const tenantId = tenantIdFromEvent(event);

    if (method === "GET" && path === "/admin/products") {
      const products = await db
        .select()
        .from(productMaster)
        .where(eq(productMaster.tenantId, tenantId))
        .orderBy(desc(productMaster.updatedAt))
        .limit(200);
      return json(200, { products });
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "not_found" });
      const listings = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.productId, id)));
      const [inventory] = await db
        .select()
        .from(inventoryMaster)
        .where(and(eq(inventoryMaster.tenantId, tenantId), eq(inventoryMaster.productId, id)))
        .limit(1);
      return json(200, { product, listings, inventory });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/approve-ebay-listing$/.test(path)) {
      const id = path.split("/")[3]!;
      const [ebayListing] = await db
        .select()
        .from(channelListings)
        .where(
          and(eq(channelListings.tenantId, tenantId), eq(channelListings.productId, id), eq(channelListings.channel, "ebay")),
        )
        .limit(1);
      if (!ebayListing) return json(404, { error: "no_ebay_draft_for_product" });
      if (ebayListing.status === "published") return json(409, { error: "already_published" });

      const queues = getQueueUrls();
      await enqueue(queues.ebaySync, { type: "ebay_publish", tenantId, productId: id }, `${tenantId}:ebay-publish:${id}`);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_listing_publish_approved",
        entityType: "product",
        entityId: id,
      });

      return json(202, { status: "publish_queued" });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/draft-condition$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { condition?: string };
      const parsed = ItemCondition.safeParse(body.condition);
      if (!parsed.success) return json(400, { error: "invalid_condition", validValues: ItemCondition.options });

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      await db.update(aiListingDraft).set({ condition: parsed.data }).where(eq(aiListingDraft.id, draft.id));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ai_draft_condition_corrected",
        entityType: "ai_listing_draft",
        entityId: draft.id,
        before: { condition: draft.condition },
        after: { condition: parsed.data },
      });

      return json(200, { productId: id, condition: parsed.data });
    }

    if (method === "GET" && path === "/admin/sync-errors") {
      const resolvedOnly = event.queryStringParameters?.resolved === "true";
      const rows = await db
        .select()
        .from(syncErrors)
        .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.resolved, resolvedOnly)))
        .orderBy(desc(syncErrors.createdAt))
        .limit(200);
      return json(200, { syncErrors: rows });
    }

    if (method === "POST" && /^\/admin\/sync-errors\/[^/]+\/retry$/.test(path)) {
      const id = path.split("/")[3]!;
      const [error] = await db
        .select()
        .from(syncErrors)
        .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.id, id)))
        .limit(1);
      if (!error) return json(404, { error: "not_found" });
      if (!error.jobId) return json(400, { error: "error_has_no_retryable_job" });

      const [job] = await db
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.tenantId, tenantId), eq(syncJobs.id, error.jobId)))
        .limit(1);
      if (!job) return json(404, { error: "original_job_not_found" });

      const queues = getQueueUrls();
      const queueUrl =
        job.type === "ai_generate" ? queues.aiGenerate : job.type.startsWith("ebay_") ? queues.ebaySync : queues.inventorySync;
      await enqueue(
        queueUrl,
        { type: job.type, tenantId, productId: job.productId, ...job.payload },
        `${tenantId}:retry:${id}:${Date.now()}`,
      );
      await db.update(syncErrors).set({ resolved: true }).where(eq(syncErrors.id, id));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "sync_error_retried",
        entityType: "sync_error",
        entityId: id,
      });

      return json(202, { status: "retry_queued" });
    }

    if (method === "POST" && path === "/admin/ebay/location") {
      const body = JSON.parse(event.body ?? "{}") as {
        merchantLocationKey?: string;
        address?: EbayInventoryLocationAddress;
      };
      if (!body.merchantLocationKey || !body.address) {
        return json(400, { error: "merchantLocationKey_and_address_required" });
      }

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
      await adapter.createInventoryLocation(accessToken, body.merchantLocationKey, body.address);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_inventory_location_created",
        entityType: "ebay_location",
        entityId: body.merchantLocationKey,
      });

      return json(201, { merchantLocationKey: body.merchantLocationKey });
    }

    if (method === "POST" && path === "/admin/ebay/policies") {
      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
      await adapter.optInToBusinessPolicies(accessToken);
      const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all([
        adapter.createFulfillmentPolicy(accessToken, "Standard Shipping"),
        adapter.createPaymentPolicy(accessToken, "Standard Payment"),
        adapter.createReturnPolicy(accessToken, "30 Day Returns"),
      ]);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_business_policies_created",
        entityType: "ebay_account",
        entityId: accountId,
      });

      return json(201, { fulfillmentPolicyId, paymentPolicyId, returnPolicyId });
    }

    if (method === "GET" && path === "/admin/ebay/inventory-item") {
      const sku = event.queryStringParameters?.sku;
      if (!sku) return json(400, { error: "sku_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
      const item = await adapter.getRawInventoryItem(accessToken, sku);
      return json(200, { item });
    }

    if (method === "GET" && path === "/admin/ebay/offer") {
      const sku = event.queryStringParameters?.sku;
      if (!sku) return json(400, { error: "sku_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
      const offer = await adapter.getRawOffer(accessToken, sku);
      return json(200, { offer });
    }

    if (method === "POST" && path === "/admin/ebay/webhook-setup") {
      const body = JSON.parse(event.body ?? "{}") as { topicId?: string; alertEmail?: string };
      if (!body.topicId || !body.alertEmail) return json(400, { error: "topicId_and_alertEmail_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      if (!creds.webhookVerificationToken) return json(409, { error: "webhookVerificationToken_not_configured" });

      const endpoint = process.env.EBAY_WEBHOOK_ENDPOINT_URL;
      if (!endpoint) return json(500, { error: "EBAY_WEBHOOK_ENDPOINT_URL_not_configured" });

      const adapter = createEbayAdapter(creds);
      // LISTING (and other USER-scoped topics) require the connected seller's own OAuth
      // token carrying sell.listing[.read] -- an app-level client_credentials token gets a
      // generic "Internal error" (errorId 2003) instead of a clear scope-denied response.
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });
      const userAccessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

      await adapter.updateNotificationConfig(userAccessToken, body.alertEmail);
      const { destinationId } = await adapter.createNotificationDestination(
        userAccessToken,
        "AI EC Platform",
        endpoint,
        creds.webhookVerificationToken,
      );
      const { subscriptionId } = await adapter.createNotificationSubscription(userAccessToken, body.topicId, destinationId);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_webhook_subscribed",
        entityType: "ebay_account",
        entityId: destinationId,
        after: { topicId: body.topicId, subscriptionId },
      });

      return json(201, { destinationId, subscriptionId });
    }

    if (method === "GET" && path === "/admin/ebay/notification-topics") {
      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const topics = await adapter.listNotificationTopics(appAccessToken);
      return json(200, { topics });
    }

    if (method === "GET" && path === "/admin/ebay/unmanaged-listings") {
      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });
      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

      const ebayListings = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.channel, "ebay")));
      const trackedExternalIds = new Set(ebayListings.map((l) => l.externalId).filter((id): id is string => id !== null));
      // Item #5 of the third hardening round ("自動商品同一性判定"): the only products
      // that could possibly be "this unmanaged listing, just not linked yet" are ones that
      // don't already have an eBay listing of their own.
      const trackedProductIds = new Set(ebayListings.map((l) => l.productId));
      const candidateProducts: ProductIdentityCandidate[] = (
        await db.select().from(productMaster).where(eq(productMaster.tenantId, tenantId))
      )
        .filter((p) => !trackedProductIds.has(p.id))
        .map((p) => ({ productId: p.id, title: p.title, brand: p.brand, material: p.material, sizeLabel: p.sizeLabel }));

      const unmanaged: Array<{
        externalId: string;
        title: string;
        suggestedProductId: string | null;
        matchScore?: number;
        matchReasons?: string[];
      }> = [];
      let cursor: string | undefined;
      do {
        const { items, nextCursor } = await adapter.listProducts(accessToken, { cursor });
        for (const item of items) {
          if (trackedExternalIds.has(item.externalId)) continue;

          // Deterministic match first: our own product-fetch names every eBay SKU it
          // creates "base-<BASE item id>". If a live eBay SKU happens to follow that exact
          // pattern and a matching product_master row really exists, this is not a guess --
          // it is the same identifier our own pipeline would have used.
          let suggestedProductId: string | null = null;
          if (item.externalId.startsWith("base-")) {
            const [match] = await db
              .select()
              .from(productMaster)
              .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.sku, item.externalId)))
              .limit(1);
            if (match) suggestedProductId = match.id;
          }

          let matchScore: number | undefined;
          let matchReasons: string[] | undefined;
          if (!suggestedProductId) {
            // No deterministic match -- fall back to title/brand/material/size similarity.
            // Still only ever a suggestion: link-ebay-listing remains a human-triggered action.
            const [topMatch] = matchProductIdentity({ title: item.title }, candidateProducts);
            if (topMatch) {
              suggestedProductId = topMatch.productId;
              matchScore = topMatch.score;
              matchReasons = topMatch.reasons;
            }
          }

          unmanaged.push({ externalId: item.externalId, title: item.title, suggestedProductId, matchScore, matchReasons });
        }
        cursor = nextCursor;
      } while (cursor);

      return json(200, { unmanagedListings: unmanaged });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/link-ebay-listing$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { externalId?: string };
      if (!body.externalId) return json(400, { error: "externalId_required" });

      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const [existing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.productId, id), eq(channelListings.channel, "ebay")))
        .limit(1);
      if (existing) return json(409, { error: "product_already_has_an_ebay_listing" });

      const [conflictingExternalId] = await db
        .select()
        .from(channelListings)
        .where(
          and(
            eq(channelListings.tenantId, tenantId),
            eq(channelListings.channel, "ebay"),
            eq(channelListings.externalId, body.externalId),
          ),
        )
        .limit(1);
      if (conflictingExternalId) return json(409, { error: "ebay_listing_already_linked_to_another_product" });

      await db.insert(channelListings).values({
        tenantId,
        productId: id,
        channel: "ebay",
        externalId: body.externalId,
        status: "published",
        lastSyncedAt: new Date(),
      });

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_listing_linked",
        entityType: "product",
        entityId: id,
        after: { externalId: body.externalId },
      });

      return json(201, { productId: id, externalId: body.externalId });
    }

    if (method === "GET" && path === "/admin/ebay/category-suggestions") {
      const q = event.queryStringParameters?.q;
      if (!q) return json(400, { error: "q_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const suggestions = await adapter.suggestCategories(appAccessToken, q);

      return json(200, { suggestions });
    }

    if (method === "GET" && path === "/admin/ebay/required-aspects") {
      const categoryId = event.queryStringParameters?.categoryId;
      if (!categoryId) return json(400, { error: "categoryId_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const requiredAspects = await adapter.getRequiredItemAspects(appAccessToken, categoryId);

      return json(200, { categoryId, requiredAspects });
    }

    if (method === "GET" && path === "/admin/ebay/condition-policies") {
      const categoryId = event.queryStringParameters?.categoryId;
      if (!categoryId) return json(400, { error: "categoryId_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const conditions = await adapter.getConditionPolicies(appAccessToken, categoryId);

      return json(200, { categoryId, conditions });
    }

    if (method === "GET" && path === "/admin/base/product") {
      const itemId = event.queryStringParameters?.itemId;
      if (!itemId) return json(400, { error: "itemId_required" });

      const creds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
      const adapter = new BaseAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, tenantId, "base");
      if (!accountId) return json(409, { error: "no_base_account_connected" });
      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

      const product = await adapter.getProduct(accessToken, itemId);
      return json(200, { product });
    }

    if (method === "GET" && path === "/admin/sync/confidence") {
      const channel = event.queryStringParameters?.channel;
      if (!channel) return json(400, { error: "channel_required" });
      const windowHours = event.queryStringParameters?.windowHours
        ? Number(event.queryStringParameters.windowHours)
        : undefined;

      const confidence = await computeSyncConfidence(db, tenantId, channel, windowHours);
      return json(200, confidence);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/dynamic-safety-stock$/.test(path)) {
      const id = path.split("/")[3]!;
      const channel = event.queryStringParameters?.channel ?? "ebay";

      const recommendation = await computeDynamicSafetyStock(db, tenantId, id, channel);
      return json(200, recommendation);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/sync-trace$/.test(path)) {
      // Item #1 of the third hardening round ("同期原因追跡"): merges inventory_events,
      // audit_log, and sync_errors for this product into one chronological timeline, so
      // "why did inventory go from 3 to 2" is answerable without cross-referencing three
      // separate admin queries by hand.
      const id = path.split("/")[3]!;
      const limit = event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined;
      const trace = await traceSyncHistory(db, tenantId, id, limit);
      return json(200, trace);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/stockout-risk$/.test(path)) {
      // Item #5 of the second hardening round ("予測型在庫制御"): shows the same
      // stockout-risk prediction resolveSafetyStockBuffer already applies during sync,
      // so an operator can see *why* a product's public quantity was cut further.
      const id = path.split("/")[3]!;
      const risk = await predictStockoutRisk(db, tenantId, id);
      return json(200, risk);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/dynamic-price$/.test(path)) {
      // Item #4 of the third hardening round ("価格の動的整合"). Preview only -- never
      // writes anything, and never touches suggestedPriceUsd (only used as a *fallback*
      // when the AI draft has no price of its own). Query params let an operator try a
      // hypothetical shipping/margin without first persisting it via pricing-config below;
      // omitted params fall back to this product's saved config, then the platform default.
      const id = path.split("/")[3]!;
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const fx = await fetchFxRate();
      const shippingUsd = event.queryStringParameters?.shippingUsd
        ? Number(event.queryStringParameters.shippingUsd)
        : product.shippingCostUsdCents !== null
          ? product.shippingCostUsdCents / 100
          : DEFAULT_SHIPPING_USD;
      const targetMarginRatio = event.queryStringParameters?.targetMarginRatio
        ? Number(event.queryStringParameters.targetMarginRatio)
        : product.targetMarginBasisPoints !== null
          ? product.targetMarginBasisPoints / 10000
          : DEFAULT_TARGET_MARGIN_RATIO;

      const price = computeDynamicPrice({
        costJpy: product.priceJpy,
        fxRateUsdPerJpy: fx.fxRateUsdPerJpy,
        shippingUsd,
        targetMarginRatio,
      });
      return json(200, { ...price, fxSource: fx.source });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/pricing-config$/.test(path)) {
      // Persists this product's own shipping-cost/margin overrides for the dynamic price
      // calculator above (and for the fallback price computed at actual publish/update
      // time) -- null clears an override back to the platform default.
      const id = path.split("/")[3]!;
      const body = event.body ? (JSON.parse(event.body) as { shippingCostUsd?: number | null; targetMarginRatio?: number | null }) : {};
      const values: Record<string, number | null> = {};
      if ("shippingCostUsd" in body) {
        values.shippingCostUsdCents = body.shippingCostUsd === null ? null : Math.round(body.shippingCostUsd! * 100);
      }
      if ("targetMarginRatio" in body) {
        values.targetMarginBasisPoints = body.targetMarginRatio === null ? null : Math.round(body.targetMarginRatio! * 10000);
      }
      await db
        .update(productMaster)
        .set(values)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "pricing_config_updated",
        entityType: "product",
        entityId: id,
        after: values,
      });
      return json(200, { updated: true });
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/reconstruct-inventory$/.test(path)) {
      // Preview only -- never writes. Item #3 ("状態再構築"): shows what the event history
      // says quantity should be, vs. what's currently stored, without touching either.
      const id = path.split("/")[3]!;
      const preview = await reconstructInventory(db, tenantId, id);
      return json(200, preview);
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/reconstruct-inventory$/.test(path)) {
      // Applies the recomputed quantity, but only if reconstructInventory found real drift
      // -- always a human-triggered admin action, never automatic (see applyReconstructedInventory).
      const id = path.split("/")[3]!;
      const result = await applyReconstructedInventory(db, tenantId, id);

      if (result.applied) {
        await recordAuditLog(db, {
          tenantId,
          actor: actorFromEvent(event),
          action: "inventory_reconstructed",
          entityType: "product",
          entityId: id,
          before: { quantity: result.currentQuantity },
          after: { quantity: result.reconstructedQuantity, eventsReplayed: result.eventsReplayed },
        });
      }

      return json(200, result);
    }

    if (method === "GET" && path === "/admin/audit-log") {
      // tenant_id IS NULL surfaces genuine platform-level events (e.g. dlq-redrive) alongside
      // this tenant's own history -- see auditLog's schema comment for why those stay nullable.
      const rows = await db
        .select()
        .from(auditLog)
        .where(or(eq(auditLog.tenantId, tenantId), isNull(auditLog.tenantId)))
        .orderBy(desc(auditLog.createdAt))
        .limit(200);
      return json(200, { auditLog: rows });
    }

    // --- Commercial-features round: Order model (item #1) ---

    if (method === "GET" && path === "/admin/orders") {
      const status = OrderStatus.safeParse(event.queryStringParameters?.status);
      const limit = event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined;
      const orderRows = await listOrders(db, tenantId, { status: status.success ? status.data : undefined, limit });
      return json(200, { orders: orderRows });
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/orders$/.test(path)) {
      const id = path.split("/")[3]!;
      const orderRows = await listOrdersForProduct(db, tenantId, id);
      return json(200, { orders: orderRows });
    }

    if (method === "GET" && /^\/admin\/orders\/[^/]+\/profit$/.test(path)) {
      const id = path.split("/")[3]!;
      const [order] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, id)))
        .limit(1);
      if (!order) return json(404, { error: "order_not_found" });

      if (order.profitFinalizedAt) {
        return json(200, {
          finalized: true,
          netProfitUsdCents: order.finalizedNetProfitUsdCents,
          profitFinalizedAt: order.profitFinalizedAt,
        });
      }
      const usdPerJpy = await currentFxRate();
      return json(200, { finalized: false, ...getLiveOrderProfit(order, usdPerJpy) });
    }

    if (method === "POST" && /^\/admin\/orders\/[^/]+\/status$/.test(path)) {
      // Every order status change is human-triggered here -- never automatic (matches this
      // platform's existing rule that AI never changes price/listing state without approval).
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { status?: string; extra?: Record<string, number> };
      const parsedStatus = OrderStatus.safeParse(body.status);
      if (!parsedStatus.success) return json(400, { error: "invalid_status", validValues: OrderStatus.options });

      try {
        const updated = await transitionOrderStatus(db, tenantId, id, parsedStatus.data, { extra: body.extra });
        await recordAuditLog(db, {
          tenantId,
          actor: actorFromEvent(event),
          action: "order_status_changed",
          entityType: "order",
          entityId: id,
          after: { status: parsedStatus.data },
        });
        return json(200, { order: updated });
      } catch (err) {
        if (err instanceof InvalidOrderTransitionError) {
          return json(409, { error: "invalid_transition", message: err.message });
        }
        throw err;
      }
    }

    if (method === "POST" && /^\/admin\/orders\/[^/]+\/finalize-profit$/.test(path)) {
      // 利益確定 lifecycle stage. Safe to call more than once (see finalizeOrderProfit) --
      // e.g. an admin corrects a fee via the status/extra field, then re-finalizes.
      const id = path.split("/")[3]!;
      const usdPerJpy = await currentFxRate();
      const updated = await finalizeOrderProfit(db, tenantId, id, usdPerJpy);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "order_profit_finalized",
        entityType: "order",
        entityId: id,
        after: { netProfitUsdCents: updated.finalizedNetProfitUsdCents },
      });
      return json(200, { order: updated });
    }

    // --- Commercial-features round: 仕入 (purchase cost entry, item #3/#4) ---

    if (method === "POST" && /^\/admin\/products\/[^/]+\/purchase-info$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { costJpy?: number; purchasedAt?: string };
      if (typeof body.costJpy !== "number") return json(400, { error: "costJpy_required" });

      const purchasedAt = body.purchasedAt ? new Date(body.purchasedAt) : new Date();
      await db
        .update(productMaster)
        .set({ costJpy: body.costJpy, purchasedAt, updatedAt: new Date() })
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "product_purchased",
        entityType: "product",
        entityId: id,
        after: { costJpy: body.costJpy, purchasedAt },
      });
      return json(200, { productId: id, costJpy: body.costJpy, purchasedAt });
    }

    // --- Commercial-features round: 在庫を分離 (item #2) ---

    if (method === "GET" && /^\/admin\/products\/[^/]+\/inventory-breakdown$/.test(path)) {
      const id = path.split("/")[3]!;
      const breakdown = await getInventoryBreakdown(db, tenantId, id);
      if (!breakdown) return json(404, { error: "not_found" });
      return json(200, breakdown);
    }

    // --- Commercial-features round: 滞留商品管理 (item #5) ---

    if (method === "GET" && path === "/admin/stale-products") {
      const minDays = event.queryStringParameters?.minDays ? Number(event.queryStringParameters.minDays) : undefined;
      const staleProducts = await findStaleProducts(db, tenantId, minDays);
      return json(200, { staleProducts });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/stale-suggestion$/.test(path)) {
      // Live-generated, never persisted or auto-applied -- any resulting price change or
      // re-listing still goes through the existing human-approval publish/update gates.
      const id = path.split("/")[3]!;
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const daysListed = Math.max(0, Math.floor((Date.now() - product.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
      const modelClient = createAIModelClient(process.env);
      const suggestion = await suggestStaleProductImprovement(
        modelClient,
        {
          titleJa: product.title,
          descriptionJa: product.descriptionJa,
          brand: product.brand,
          material: product.material,
          sizeLabel: product.sizeLabel,
          priceJpy: product.priceJpy,
          imageCount: product.images.length,
        },
        daysListed,
      );
      return json(200, { productId: id, daysListed, ...suggestion });
    }

    // --- Commercial-features round: SNS管理 (item #6) ---

    if (method === "GET" && /^\/admin\/products\/[^/]+\/sns$/.test(path)) {
      const id = path.split("/")[3]!;
      const content = await getSnsContent(db, tenantId, id);
      return json(200, { snsContent: content });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/sns\/script$/.test(path)) {
      const id = path.split("/")[3]!;
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const modelClient = createAIModelClient(process.env);
      const script = await generateSnsScript(modelClient, {
        titleJa: product.title,
        descriptionJa: product.descriptionJa,
        brand: product.brand,
        material: product.material,
        sizeLabel: product.sizeLabel,
        priceJpy: product.priceJpy,
        imageCount: product.images.length,
      });
      const promptVersion = "sns-script-v1";
      const saved = await upsertSnsScript(db, tenantId, id, script.scriptText, promptVersion);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "sns_script_generated",
        entityType: "product",
        entityId: id,
      });
      return json(200, { snsContent: saved, needsHumanReview: script.needsHumanReview, reviewNotes: script.reviewNotes });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/sns\/status$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as {
        videoCreated?: boolean;
        instagramPosted?: boolean;
        tiktokPosted?: boolean;
      };
      const updated = await markSnsStatus(db, tenantId, id, body);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "sns_status_updated",
        entityType: "product",
        entityId: id,
        after: body,
      });
      return json(200, { snsContent: updated });
    }

    // --- Commercial-features round: 同期状態State Machine (item #8) ---

    if (method === "GET" && path === "/admin/sync/state") {
      const channel = event.queryStringParameters?.channel;
      if (!channel) return json(400, { error: "channel_required" });
      const state = await computeChannelSyncState(db, tenantId, channel);
      return json(200, state);
    }

    // --- New in the multi-tenant retrofit: mint the signed OAuth authorize URL server-side
    // from this caller's own tenantId, rather than trusting a client-supplied tenant hint on
    // the public /oauth/.../authorize routes (see services/lambdas/oauth-{base,ebay}). ---

    if (method === "GET" && /^\/admin\/oauth\/(base|ebay)\/authorize-url$/.test(path)) {
      const channel = path.split("/")[3] as "base" | "ebay";
      if (channel === "ebay") {
        const creds = await getAppCredentials<EbayAppCredentials>("ebay");
        const adapter = createEbayAdapter(creds);
        const state = signState(creds.clientSecret, tenantId);
        const url = adapter.getAuthorizationUrl(state, creds.ruName);
        return json(200, { url });
      }
      const creds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
      const adapter = new BaseAdapter(creds);
      const state = signState(creds.clientSecret, tenantId);
      const url = adapter.getAuthorizationUrl(state, requireEnv("BASE_OAUTH_REDIRECT_URI"));
      return json(200, { url });
    }

    // --- Commercial-features round: SLO/監視 (item #9) ---

    if (method === "GET" && path === "/admin/slo") {
      const windowHours = event.queryStringParameters?.windowHours ? Number(event.queryStringParameters.windowHours) : 24;
      const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

      const [baseConfidence, ebayConfidence] = await Promise.all([
        computeSyncConfidence(db, tenantId, "base", windowHours),
        computeSyncConfidence(db, tenantId, "ebay", windowHours),
      ]);

      const driftErrors = await db
        .select()
        .from(syncErrors)
        .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.errorCode, "inventory_drift"), gte(syncErrors.createdAt, since)));

      const [aiFailures, aiDrafts] = await Promise.all([
        db
          .select()
          .from(syncErrors)
          .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.errorCode, "ai_generate_failed"), gte(syncErrors.createdAt, since))),
        db
          .select()
          .from(aiListingDraft)
          .where(and(eq(aiListingDraft.tenantId, tenantId), gte(aiListingDraft.createdAt, since))),
      ]);
      const aiAttemptCount = aiFailures.length + aiDrafts.length;

      // Platform-level (tenant_id IS NULL): a DLQ redrive moves whatever's in the shared
      // queue regardless of whose messages they are, so this is intentionally NOT tenant-filtered.
      const recentAutoRecoveryEvents = await db
        .select()
        .from(auditLog)
        .where(and(isNull(auditLog.tenantId), eq(auditLog.action, "dlq_redrive_started"), gte(auditLog.createdAt, since)))
        .orderBy(desc(auditLog.createdAt))
        .limit(20);

      // DLQ depth is best-effort: omitted (rather than failing the whole endpoint) if this
      // Lambda hasn't been redeployed with the DLQ URL env vars yet.
      let dlqDepths: Record<string, number> | null = null;
      try {
        const dlqUrls = getDlqUrls();
        const [aiGenerate, ebaySync, inventorySync] = await Promise.all([
          getApproximateMessageCount(dlqUrls.aiGenerate),
          getApproximateMessageCount(dlqUrls.ebaySync),
          getApproximateMessageCount(dlqUrls.inventorySync),
        ]);
        dlqDepths = { aiGenerate, ebaySync, inventorySync };
      } catch {
        // Missing env vars -- see comment above.
      }

      return json(200, {
        windowHours,
        syncSuccessRate: { base: baseConfidence, ebay: ebayConfidence },
        inventoryInconsistencyCount: driftErrors.length,
        aiFailureRate: { failureCount: aiFailures.length, attemptCount: aiAttemptCount, rate: aiAttemptCount > 0 ? aiFailures.length / aiAttemptCount : null },
        dlqDepths,
        recentAutoRecoveryEvents,
        // Per-function API latency is already on the CloudWatch dashboard (MonitoringStack) --
        // not duplicated here; see the round's report for why.
      });
    }

    // --- Commercial-features round: unified commerce dashboard (UI, item requested separately) ---

    if (method === "GET" && path === "/admin/commerce-dashboard") {
      // Each product row costs several DB round trips (channel_listings, inventory
      // breakdown, orders, sns_content) run in parallel across products -- a modest default
      // keeps this endpoint's total concurrent RDS Data API calls bounded; pass ?limit= for
      // a larger catalog at the caller's own risk.
      const limit = event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : 30;
      const products = await db
        .select()
        .from(productMaster)
        .where(eq(productMaster.tenantId, tenantId))
        .orderBy(desc(productMaster.updatedAt))
        .limit(limit);
      const usdPerJpy = await currentFxRate();

      const rows = await Promise.all(
        products.map(async (product) => {
          const [listings, breakdown, productOrders, sns] = await Promise.all([
            db
              .select()
              .from(channelListings)
              .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.productId, product.id))),
            getInventoryBreakdown(db, tenantId, product.id),
            listOrdersForProduct(db, tenantId, product.id),
            getSnsContent(db, tenantId, product.id),
          ]);

          let totalRevenueUsdCents = 0;
          let totalNetProfitUsdCents = 0;
          for (const order of productOrders) {
            if (order.profitFinalizedAt) {
              totalNetProfitUsdCents += order.finalizedNetProfitUsdCents ?? 0;
            } else {
              const profit = getLiveOrderProfit(order, usdPerJpy);
              totalRevenueUsdCents += profit.revenueUsdCents;
              totalNetProfitUsdCents += profit.netProfitUsdCents;
            }
          }
          const profitMarginBasisPoints =
            totalRevenueUsdCents > 0 ? Math.round((totalNetProfitUsdCents / totalRevenueUsdCents) * 10000) : null;

          const daysListed = Math.max(0, Math.floor((Date.now() - product.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
          const sortedByPlacedAt = [...productOrders].sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
          const firstOrder = sortedByPlacedAt[0];
          const daysToFirstSale = firstOrder
            ? Math.max(0, Math.floor((firstOrder.placedAt.getTime() - product.createdAt.getTime()) / (24 * 60 * 60 * 1000)))
            : null;
          const latestOrder = sortedByPlacedAt[sortedByPlacedAt.length - 1] ?? null;
          const hasReturn = productOrders.some((o) => ["RETURN_REQUESTED", "RETURNED", "REFUNDED"].includes(o.status));

          return {
            productId: product.id,
            sku: product.sku,
            title: product.title,
            status: product.status,
            images: product.images,
            channelStatus: Object.fromEntries(listings.map((l) => [l.channel, l.status])),
            lastSyncedAt: Object.fromEntries(listings.map((l) => [l.channel, l.lastSyncedAt?.toISOString() ?? null])),
            inventory: breakdown,
            revenueUsdCents: totalRevenueUsdCents,
            netProfitUsdCents: totalNetProfitUsdCents,
            profitMarginBasisPoints,
            daysListed,
            daysToFirstSale,
            staleLevel: classifyStaleness(daysListed),
            latestOrderStatus: latestOrder?.status ?? null,
            hasReturn,
            snsStatus: sns,
          };
        }),
      );

      return json(200, { products: rows });
    }

    // --- Dashboard summary (UI): month-to-date/previous-month KPIs, a daily revenue/profit
    // trend, recent orders, and an inventory rollup, all in one call for the dashboard page. ---

    if (method === "GET" && path === "/admin/dashboard/summary") {
      const TREND_DAYS = 14;
      // A dashboard-wide inventory rollup costs one breakdown call per product (same N+1
      // pattern /admin/commerce-dashboard already accepts) -- bounded the same way, via an
      // overridable default, rather than left unbounded for a large catalog.
      const productLimit = event.queryStringParameters?.productLimit
        ? Number(event.queryStringParameters.productLimit)
        : 100;

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const prevMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const trendStart = new Date(now.getTime() - (TREND_DAYS - 1) * 24 * 60 * 60 * 1000);
      trendStart.setUTCHours(0, 0, 0, 0);
      const since = trendStart < prevMonthStart ? trendStart : prevMonthStart;

      const usdPerJpy = await currentFxRate();
      const relevantOrders = await db
        .select()
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), gte(orders.placedAt, since)));
      const products = await db
        .select()
        .from(productMaster)
        .where(eq(productMaster.tenantId, tenantId))
        .limit(productLimit);
      const productById = new Map(products.map((p) => [p.id, p]));

      // Computed once per order (rather than re-derived every time it's touched below) so a
      // single order's profit is asked of getLiveOrderProfit exactly once.
      const profitByOrderId = new Map(
        relevantOrders.map((order) => {
          const live = getLiveOrderProfit(order, usdPerJpy);
          return [
            order.id,
            {
              revenueUsdCents: live.revenueUsdCents,
              netProfitUsdCents: order.profitFinalizedAt ? (order.finalizedNetProfitUsdCents ?? 0) : live.netProfitUsdCents,
            },
          ];
        }),
      );
      const profitFor = (order: (typeof relevantOrders)[number]) => profitByOrderId.get(order.id)!;

      const summarize = (rows: typeof relevantOrders) => {
        let revenueUsdCents = 0;
        let netProfitUsdCents = 0;
        const ordersByChannel: Record<string, number> = {};
        for (const order of rows) {
          const p = profitFor(order);
          revenueUsdCents += p.revenueUsdCents;
          netProfitUsdCents += p.netProfitUsdCents;
          ordersByChannel[order.channel] = (ordersByChannel[order.channel] ?? 0) + 1;
        }
        return {
          revenueUsdCents,
          netProfitUsdCents,
          profitMarginBasisPoints: revenueUsdCents > 0 ? Math.round((netProfitUsdCents / revenueUsdCents) * 10000) : null,
          orderCount: rows.length,
          ordersByChannel,
        };
      };

      const currentMonthOrders = relevantOrders.filter((o) => o.placedAt >= monthStart);
      const previousMonthOrders = relevantOrders.filter((o) => o.placedAt >= prevMonthStart && o.placedAt < monthStart);

      const trend: Array<{
        date: string;
        revenueUsdCents: number;
        netProfitUsdCents: number;
        channelRevenueUsdCents: Record<string, number>;
        channelNetProfitUsdCents: Record<string, number>;
      }> = [];
      for (let i = 0; i < TREND_DAYS; i++) {
        const dayStart = new Date(trendStart.getTime() + i * 24 * 60 * 60 * 1000);
        const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
        const dayOrders = relevantOrders.filter((o) => o.placedAt >= dayStart && o.placedAt < dayEnd);
        let revenueUsdCents = 0;
        let netProfitUsdCents = 0;
        const channelRevenueUsdCents: Record<string, number> = {};
        const channelNetProfitUsdCents: Record<string, number> = {};
        for (const order of dayOrders) {
          const p = profitFor(order);
          revenueUsdCents += p.revenueUsdCents;
          netProfitUsdCents += p.netProfitUsdCents;
          channelRevenueUsdCents[order.channel] = (channelRevenueUsdCents[order.channel] ?? 0) + p.revenueUsdCents;
          channelNetProfitUsdCents[order.channel] = (channelNetProfitUsdCents[order.channel] ?? 0) + p.netProfitUsdCents;
        }
        trend.push({
          date: dayStart.toISOString().slice(0, 10),
          revenueUsdCents,
          netProfitUsdCents,
          channelRevenueUsdCents,
          channelNetProfitUsdCents,
        });
      }

      const recentOrders = [...relevantOrders]
        .sort((a, b) => b.placedAt.getTime() - a.placedAt.getTime())
        .slice(0, 5)
        .map((o) => {
          const product = productById.get(o.productId);
          return {
            id: o.id,
            productId: o.productId,
            productTitle: product?.title ?? null,
            sku: product?.sku ?? null,
            channel: o.channel,
            revenueUsdCents: profitFor(o).revenueUsdCents,
            status: o.status,
            placedAt: o.placedAt.toISOString(),
          };
        });

      const breakdowns = await Promise.all(products.map((p) => getInventoryBreakdown(db, tenantId, p.id)));
      let totalAvailable = 0;
      let lowStockCount = 0;
      for (const b of breakdowns) {
        if (!b) continue;
        totalAvailable += b.available;
        if (b.available <= b.safetyBuffer) lowStockCount++;
      }

      return json(200, {
        currentMonth: summarize(currentMonthOrders),
        previousMonth: summarize(previousMonthOrders),
        trend,
        recentOrders,
        inventory: { totalAvailable, lowStockCount },
      });
    }

    return json(404, { error: "route_not_found" });
  } catch (err) {
    if (err instanceof MissingTenantClaimError) {
      return json(403, { error: "missing_tenant_claim" });
    }
    return json(500, { error: "internal_error", message: (err as Error).message });
  }
}
