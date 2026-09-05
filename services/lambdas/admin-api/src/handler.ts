import { BaseAdapter } from "@ai-ec/adapter-base";
import type { EbayInventoryLocationAddress } from "@ai-ec/adapter-ebay";
import { ItemCondition } from "@ai-ec/core";
import {
  aiListingDraft,
  applyReconstructedInventory,
  auditLog,
  channelListings,
  computeDynamicSafetyStock,
  computeSyncConfidence,
  inventoryMaster,
  predictStockoutRisk,
  productMaster,
  reconstructInventory,
  syncErrors,
  syncJobs,
  traceSyncHistory,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  enqueue,
  getAppCredentials,
  getDb,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import { and, desc, eq } from "drizzle-orm";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Identity of the signed-in admin operator, as attached by the Cognito JWT authorizer. */
function actorFromEvent(event: APIGatewayProxyEventV2): string {
  const claims = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, string> } } })
    .authorizer?.jwt?.claims;
  return claims?.email ?? claims?.sub ?? "unknown-admin";
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const db = getDb();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === "GET" && path === "/admin/products") {
      const products = await db.select().from(productMaster).orderBy(desc(productMaster.updatedAt)).limit(200);
      return json(200, { products });
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, id)).limit(1);
      if (!product) return json(404, { error: "not_found" });
      const listings = await db.select().from(channelListings).where(eq(channelListings.productId, id));
      const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, id)).limit(1);
      return json(200, { product, listings, inventory });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/approve-ebay-listing$/.test(path)) {
      const id = path.split("/")[3]!;
      const [ebayListing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.productId, id), eq(channelListings.channel, "ebay")))
        .limit(1);
      if (!ebayListing) return json(404, { error: "no_ebay_draft_for_product" });
      if (ebayListing.status === "published") return json(409, { error: "already_published" });

      const queues = getQueueUrls();
      await enqueue(queues.ebaySync, { type: "ebay_publish", productId: id }, `ebay-publish:${id}`);

      await recordAuditLog(db, {
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
        .where(eq(aiListingDraft.productId, id))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      await db.update(aiListingDraft).set({ condition: parsed.data }).where(eq(aiListingDraft.id, draft.id));

      await recordAuditLog(db, {
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
        .where(eq(syncErrors.resolved, resolvedOnly))
        .orderBy(desc(syncErrors.createdAt))
        .limit(200);
      return json(200, { syncErrors: rows });
    }

    if (method === "POST" && /^\/admin\/sync-errors\/[^/]+\/retry$/.test(path)) {
      const id = path.split("/")[3]!;
      const [error] = await db.select().from(syncErrors).where(eq(syncErrors.id, id)).limit(1);
      if (!error) return json(404, { error: "not_found" });
      if (!error.jobId) return json(400, { error: "error_has_no_retryable_job" });

      const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, error.jobId)).limit(1);
      if (!job) return json(404, { error: "original_job_not_found" });

      const queues = getQueueUrls();
      const queueUrl =
        job.type === "ai_generate" ? queues.aiGenerate : job.type.startsWith("ebay_") ? queues.ebaySync : queues.inventorySync;
      await enqueue(queueUrl, { type: job.type, productId: job.productId, ...job.payload }, `retry:${id}:${Date.now()}`);
      await db.update(syncErrors).set({ resolved: true }).where(eq(syncErrors.id, id));

      await recordAuditLog(db, {
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
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, adapter, accountId);
      await adapter.createInventoryLocation(accessToken, body.merchantLocationKey, body.address);

      await recordAuditLog(db, {
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
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, adapter, accountId);
      await adapter.optInToBusinessPolicies(accessToken);
      const [fulfillmentPolicyId, paymentPolicyId, returnPolicyId] = await Promise.all([
        adapter.createFulfillmentPolicy(accessToken, "Standard Shipping"),
        adapter.createPaymentPolicy(accessToken, "Standard Payment"),
        adapter.createReturnPolicy(accessToken, "30 Day Returns"),
      ]);

      await recordAuditLog(db, {
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
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, adapter, accountId);
      const item = await adapter.getRawInventoryItem(accessToken, sku);
      return json(200, { item });
    }

    if (method === "GET" && path === "/admin/ebay/offer") {
      const sku = event.queryStringParameters?.sku;
      if (!sku) return json(400, { error: "sku_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, adapter, accountId);
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
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });
      const userAccessToken = await getValidAccessToken(db, adapter, accountId);

      await adapter.updateNotificationConfig(userAccessToken, body.alertEmail);
      const { destinationId } = await adapter.createNotificationDestination(
        userAccessToken,
        "AI EC Platform",
        endpoint,
        creds.webhookVerificationToken,
      );
      const { subscriptionId } = await adapter.createNotificationSubscription(userAccessToken, body.topicId, destinationId);

      await recordAuditLog(db, {
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
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });
      const accessToken = await getValidAccessToken(db, adapter, accountId);

      const trackedExternalIds = new Set(
        (await db.select().from(channelListings).where(eq(channelListings.channel, "ebay")))
          .map((l) => l.externalId)
          .filter((id): id is string => id !== null),
      );

      const unmanaged: Array<{ externalId: string; title: string; suggestedProductId: string | null }> = [];
      let cursor: string | undefined;
      do {
        const { items, nextCursor } = await adapter.listProducts(accessToken, { cursor });
        for (const item of items) {
          if (trackedExternalIds.has(item.externalId)) continue;

          // Deterministic match only: our own product-fetch names every eBay SKU it creates
          // "base-<BASE item id>". If a live eBay SKU happens to follow that exact pattern
          // and a matching product_master row really exists, this is not a guess -- it is
          // the same identifier our own pipeline would have used. Anything else is left null
          // for a human to link explicitly rather than fuzzy-matched by title/image.
          let suggestedProductId: string | null = null;
          if (item.externalId.startsWith("base-")) {
            const [match] = await db.select().from(productMaster).where(eq(productMaster.sku, item.externalId)).limit(1);
            if (match) suggestedProductId = match.id;
          }

          unmanaged.push({ externalId: item.externalId, title: item.title, suggestedProductId });
        }
        cursor = nextCursor;
      } while (cursor);

      return json(200, { unmanagedListings: unmanaged });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/link-ebay-listing$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { externalId?: string };
      if (!body.externalId) return json(400, { error: "externalId_required" });

      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, id)).limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const [existing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.productId, id), eq(channelListings.channel, "ebay")))
        .limit(1);
      if (existing) return json(409, { error: "product_already_has_an_ebay_listing" });

      const [conflictingExternalId] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.channel, "ebay"), eq(channelListings.externalId, body.externalId)))
        .limit(1);
      if (conflictingExternalId) return json(409, { error: "ebay_listing_already_linked_to_another_product" });

      await db.insert(channelListings).values({
        productId: id,
        channel: "ebay",
        externalId: body.externalId,
        status: "published",
        lastSyncedAt: new Date(),
      });

      await recordAuditLog(db, {
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
      const [accountId] = await listConnectedAccountIds(db, "base");
      if (!accountId) return json(409, { error: "no_base_account_connected" });
      const accessToken = await getValidAccessToken(db, adapter, accountId);

      const product = await adapter.getProduct(accessToken, itemId);
      return json(200, { product });
    }

    if (method === "GET" && path === "/admin/sync/confidence") {
      const channel = event.queryStringParameters?.channel;
      if (!channel) return json(400, { error: "channel_required" });
      const windowHours = event.queryStringParameters?.windowHours
        ? Number(event.queryStringParameters.windowHours)
        : undefined;

      const confidence = await computeSyncConfidence(db, channel, windowHours);
      return json(200, confidence);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/dynamic-safety-stock$/.test(path)) {
      const id = path.split("/")[3]!;
      const channel = event.queryStringParameters?.channel ?? "ebay";

      const recommendation = await computeDynamicSafetyStock(db, id, channel);
      return json(200, recommendation);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/sync-trace$/.test(path)) {
      // Item #1 of the third hardening round ("同期原因追跡"): merges inventory_events,
      // audit_log, and sync_errors for this product into one chronological timeline, so
      // "why did inventory go from 3 to 2" is answerable without cross-referencing three
      // separate admin queries by hand.
      const id = path.split("/")[3]!;
      const limit = event.queryStringParameters?.limit ? Number(event.queryStringParameters.limit) : undefined;
      const trace = await traceSyncHistory(db, id, limit);
      return json(200, trace);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/stockout-risk$/.test(path)) {
      // Item #5 of the second hardening round ("予測型在庫制御"): shows the same
      // stockout-risk prediction resolveSafetyStockBuffer already applies during sync,
      // so an operator can see *why* a product's public quantity was cut further.
      const id = path.split("/")[3]!;
      const risk = await predictStockoutRisk(db, id);
      return json(200, risk);
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+\/reconstruct-inventory$/.test(path)) {
      // Preview only -- never writes. Item #3 ("状態再構築"): shows what the event history
      // says quantity should be, vs. what's currently stored, without touching either.
      const id = path.split("/")[3]!;
      const preview = await reconstructInventory(db, id);
      return json(200, preview);
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/reconstruct-inventory$/.test(path)) {
      // Applies the recomputed quantity, but only if reconstructInventory found real drift
      // -- always a human-triggered admin action, never automatic (see applyReconstructedInventory).
      const id = path.split("/")[3]!;
      const result = await applyReconstructedInventory(db, id);

      if (result.applied) {
        await recordAuditLog(db, {
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
      const rows = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
      return json(200, { auditLog: rows });
    }

    return json(404, { error: "route_not_found" });
  } catch (err) {
    return json(500, { error: "internal_error", message: (err as Error).message });
  }
}
