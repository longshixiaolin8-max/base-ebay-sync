import { BaseAdapter } from "@ai-ec/adapter-base";
import type { EbayInventoryLocationAddress } from "@ai-ec/adapter-ebay";
import { createAIModelClient, generateSnsScript, suggestStaleProductImprovement } from "@ai-ec/ai";
import {
  applyStandardAspectFallbacks,
  ChannelType,
  classifyInventoryDiffMagnitude,
  classifyStaleness,
  computeDynamicPrice,
  DEFAULT_SHIPPING_USD,
  DEFAULT_TARGET_MARGIN_RATIO,
  draftConfidenceScore,
  findMissingRequiredAspects,
  getPlanLimits,
  ItemCondition,
  matchProductIdentity,
  OrderStatus,
  type ProductIdentityCandidate,
  ProductStatus,
} from "@ai-ec/core";
import {
  aiListingDraft,
  applyReconstructedInventory,
  auditLog,
  channelListings,
  computeChannelSyncState,
  computeDynamicSafetyStock,
  computeSyncConfidence,
  countChannelListingsByStatus,
  countProducts,
  countProductsByStatus,
  finalizeOrderProfit,
  findStaleProducts,
  getInventoryBreakdown,
  getLatestSyncedAt,
  getLiveOrderProfit,
  getMonthlyAiGenerationCount,
  getSnsContent,
  getTenantBillingStatus,
  InvalidOrderTransitionError,
  inventoryMaster,
  listOrders,
  listOrdersForProduct,
  markSnsStatus,
  oauthConnections,
  orders,
  predictStockoutRisk,
  productMaster,
  reconstructInventory,
  releaseMonthlyAiGenerationReservation,
  syncErrors,
  syncJobs,
  tenants,
  traceSyncHistory,
  transitionOrderStatus,
  tryReserveMonthlyAiGeneration,
  upsertSnsScript,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  createStripeClient,
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
  requireCloudFrontOrigin,
  requireEnv,
  signState,
  signWebhookDestinationToken,
  type EbayAppCredentials,
  type StripeAppCredentials,
} from "@ai-ec/lambda-shared";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
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
  const cloudFrontRejection = requireCloudFrontOrigin(event);
  if (cloudFrontRejection) return cloudFrontRejection;

  const db = getDb();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    const tenantId = tenantIdFromEvent(event);

    // Phase 2 of the SaaS conversion ("self-service signup + Stripe test-mode billing").
    // A tenant created via /signup starts 'pending_payment' and only becomes usable once
    // the Stripe webhook confirms a completed checkout -- every other route is gated on
    // that, except the two billing routes themselves (an inactive tenant must still be
    // able to see *why* it's blocked and fix it via the Stripe portal). The existing real
    // tenant is unaffected: its status is 'active' from the migration's column default.
    //
    // 'canceled_grace' (added for the post-cancellation data-egress gap identified in the
    // commercial-readiness audit) is a narrower carve-out than the exemption above: rather
    // than blocking every route, a tenant in that state keeps read-only (GET) access to its
    // own data -- including every CSV export, which is built client-side from these same
    // GET responses -- until gracePeriodEndsAt, so canceling never locks a store out of its
    // own data with zero notice. Any write (POST/PUT/DELETE) still 402s immediately.
    const billingExemptRoutes = new Set(["GET /admin/billing/status", "POST /admin/billing/portal-session"]);
    if (!billingExemptRoutes.has(`${method} ${path}`)) {
      const billing = await getTenantBillingStatus(db, tenantId);
      const inGracePeriod =
        billing?.status === "canceled_grace" && !!billing.gracePeriodEndsAt && billing.gracePeriodEndsAt.getTime() > Date.now();
      const allowed = billing?.status === "active" || (inGracePeriod && method === "GET");
      if (!allowed) {
        return json(402, {
          error: "billing_inactive",
          status: billing?.status ?? "unknown",
          gracePeriodEndsAt: billing?.gracePeriodEndsAt?.toISOString() ?? null,
        });
      }
    }

    if (method === "GET" && path === "/admin/billing/status") {
      const billing = await getTenantBillingStatus(db, tenantId);
      if (!billing) return json(404, { error: "not_found" });
      // This route is billing-exempt and checked on every page load (see
      // useRequireAuth), so a missing/not-yet-configured Stripe secret must never fail
      // it -- only the "デモ契約" badge hint is at stake. Absent real credentials is
      // itself not live billing, so treat that failure as testMode.
      let testMode = true;
      try {
        const creds = await getAppCredentials<StripeAppCredentials>("stripe");
        // Real signal, not a guess: Stripe secret keys are prefixed sk_test_/sk_live_ by
        // Stripe itself. Lets the UI show a "デモ契約" badge only when this tenant's
        // billing is genuinely running against Stripe's test mode, never unconditionally.
        testMode = creds.secretKey.startsWith("sk_test_");
      } catch {
        // Stripe secret not yet configured with real credentials -- fall through with
        // the safe default above.
      }
      return json(200, {
        plan: billing.plan,
        status: billing.status,
        testMode,
        gracePeriodEndsAt: billing.gracePeriodEndsAt?.toISOString() ?? null,
      });
    }

    if (method === "POST" && path === "/admin/billing/portal-session") {
      const billing = await getTenantBillingStatus(db, tenantId);
      if (!billing?.stripeCustomerId) return json(400, { error: "no_stripe_customer" });
      const creds = await getAppCredentials<StripeAppCredentials>("stripe");
      const stripe = createStripeClient(creds);
      const session = await stripe.billingPortal.sessions.create({
        customer: billing.stripeCustomerId,
        return_url: `${requireEnv("ADMIN_APP_URL")}/billing`,
      });
      return json(200, { url: session.url });
    }

    if (method === "GET" && path === "/admin/billing/details") {
      const billing = await getTenantBillingStatus(db, tenantId);
      if (!billing?.stripeCustomerId) return json(400, { error: "no_stripe_customer" });
      const creds = await getAppCredentials<StripeAppCredentials>("stripe");
      const stripe = createStripeClient(creds);

      const customer = await stripe.customers.retrieve(billing.stripeCustomerId, {
        expand: ["invoice_settings.default_payment_method"],
      });
      const paymentMethod =
        !customer.deleted &&
        customer.invoice_settings?.default_payment_method &&
        typeof customer.invoice_settings.default_payment_method === "object" &&
        customer.invoice_settings.default_payment_method.card
          ? {
              brand: customer.invoice_settings.default_payment_method.card.brand,
              last4: customer.invoice_settings.default_payment_method.card.last4,
              expMonth: customer.invoice_settings.default_payment_method.card.exp_month,
              expYear: customer.invoice_settings.default_payment_method.card.exp_year,
            }
          : null;

      const invoicesRes = await stripe.invoices.list({ customer: billing.stripeCustomerId, limit: 12 });
      const invoices = invoicesRes.data.map((inv) => ({
        id: inv.id,
        amountUsdCents: inv.amount_paid,
        createdAt: new Date(inv.created * 1000).toISOString(),
        status: inv.status,
        hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
      }));

      let subscription:
        | {
            currentPeriodEnd: string | null;
            cancelAtPeriodEnd: boolean;
            priceAmount: number | null;
            priceCurrency: string | null;
            priceInterval: string | null;
            trialEnd: string | null;
          }
        | null = null;
      if (billing.stripeSubscriptionId) {
        const sub = await stripe.subscriptions.retrieve(billing.stripeSubscriptionId);
        // Stripe moved the billing-period fields off the subscription itself and onto
        // each subscription item in newer API versions -- this platform's subscriptions
        // are always single-item (one flat plan, see plan-limits.ts), so the first item
        // is the only one that could ever exist.
        const item = sub.items.data[0];
        subscription = {
          currentPeriodEnd: item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          // The tenant's real, currently-active subscription price -- straight from Stripe,
          // not a figure this codebase invents or advertises anywhere else.
          priceAmount: item?.price.unit_amount ?? null,
          priceCurrency: item?.price.currency ?? null,
          priceInterval: item?.price.recurring?.interval ?? null,
          // Set only while the free trial (signup's own subscription_data.trial_period_days)
          // is still running; null once it ends, whether the card was successfully charged
          // or the subscription lapsed -- the billing page uses this to show the operator
          // exactly when they'll first actually be charged.
          trialEnd: sub.status === "trialing" && sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        };
      }

      return json(200, { paymentMethod, invoices, subscription });
    }

    if (method === "POST" && path === "/admin/billing/cancel") {
      const billing = await getTenantBillingStatus(db, tenantId);
      if (!billing?.stripeSubscriptionId) return json(400, { error: "no_stripe_subscription" });
      const creds = await getAppCredentials<StripeAppCredentials>("stripe");
      const stripe = createStripeClient(creds);
      // cancel_at_period_end, not an immediate cancellation -- the tenant keeps access
      // (and its sync/AI-generation quota) through the period it already paid for, exactly
      // matching the plan card's own "次回更新日に契約終了となります" copy.
      const sub = await stripe.subscriptions.update(billing.stripeSubscriptionId, { cancel_at_period_end: true });
      const periodEnd = sub.items.data[0]?.current_period_end;
      const currentPeriodEnd = periodEnd ? new Date(periodEnd * 1000).toISOString() : null;
      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "subscription_cancel_scheduled",
        entityType: "tenant",
        entityId: tenantId,
        after: { cancelAtPeriodEnd: true, currentPeriodEnd },
      });
      return json(200, { cancelAtPeriodEnd: sub.cancel_at_period_end, currentPeriodEnd });
    }

    if (method === "GET" && path === "/admin/tenant") {
      const billing = await getTenantBillingStatus(db, tenantId);
      if (!billing) return json(404, { error: "not_found" });
      return json(200, { name: billing.name });
    }

    // Phase 3 of the SaaS conversion ("plan quota enforcement"). Informational only --
    // unlike the two billing routes above, this stays inside the normal billing-active
    // gate (an inactive tenant has nothing productive to do with its usage numbers).
    if (method === "GET" && path === "/admin/usage") {
      const billing = await getTenantBillingStatus(db, tenantId);
      const limits = getPlanLimits(billing?.plan ?? "standard");
      const [productsUsed, aiGenerationsUsed] = await Promise.all([
        countProducts(db, tenantId),
        getMonthlyAiGenerationCount(db, tenantId),
      ]);
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return json(200, {
        products: { used: productsUsed, limit: limits.maxProducts },
        aiGenerations: { used: aiGenerationsUsed, limit: limits.maxAiGenerationsPerMonth, periodStart: periodStart.toISOString() },
      });
    }

    if (method === "GET" && path === "/admin/products") {
      const products = await db
        .select()
        .from(productMaster)
        .where(eq(productMaster.tenantId, tenantId))
        .orderBy(desc(productMaster.updatedAt))
        .limit(200);
      return json(200, { products });
    }

    // --- 商品マスター table redesign: real server-side pagination/filtering, and catalog-
    // wide KPI counts (independent of whatever filter is active, matching the design's KPI
    // row staying constant while the table below it is filtered). Placed BEFORE the
    // single-product GET below, since that route's /^\/admin\/products\/[^/]+$/ regex would
    // otherwise treat "list" as a product id.
    //
    // No "category" filter/column: product_master has no category field (grepped the whole
    // schema) -- this platform doesn't track a product taxonomy today, so a category filter
    // here would have nothing real to query against. The frontend renders that filter as a
    // visible-but-inert "すべて" only, not a fabricated API.
    if (method === "GET" && path === "/admin/products/list") {
      const limit = Math.min(100, Math.max(1, Number(event.queryStringParameters?.limit) || 10));
      const offset = Math.max(0, Number(event.queryStringParameters?.offset) || 0);
      const statusParsed = ProductStatus.safeParse(event.queryStringParameters?.status);
      const channelParsed = ChannelType.safeParse(event.queryStringParameters?.channel);
      const syncStatusRaw = event.queryStringParameters?.syncStatus;
      const syncStatus = (["pending", "published", "update_pending", "error", "delisted"] as const).find((s) => s === syncStatusRaw);
      const q = event.queryStringParameters?.q?.trim();
      // 在庫監視 page's filter dimension -- distinct from `status` (product lifecycle) above.
      // possible_double_sale/inventory_drift are never a persisted column (see the sets built
      // below), so this can't be a plain `eq()` -- it narrows to a precomputed id list instead.
      const diffStatusRaw = event.queryStringParameters?.diffStatus;
      const diffStatus = (["attention", "possible_double_sale", "sold_out"] as const).find((s) => s === diffStatusRaw);

      // Whole-tenant, independent of the current page/filter -- feeds both the diffStatus
      // filter above and the inventoryKpi/inventoryHealthByChannel aggregates below, same
      // "KPI never scoped to the currently-filtered page" convention as every other list KPI
      // in this file. Cheap: these are rare, unresolved-only rows, never the full catalog.
      const [unresolvedDrift, unresolvedDoubleSale, safetyStockBySourceChannel] = await Promise.all([
        db
          .select({ productId: syncErrors.productId, channel: syncErrors.channel, payload: syncErrors.payload })
          .from(syncErrors)
          .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.errorCode, "inventory_drift"), eq(syncErrors.resolved, false))),
        db
          .select({ productId: syncErrors.productId, channel: syncErrors.channel })
          .from(syncErrors)
          .where(and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.errorCode, "possible_double_sale"), eq(syncErrors.resolved, false))),
        db
          .select({ sourceChannel: productMaster.sourceChannel, count: sql<number>`count(*)::int` })
          .from(productMaster)
          .leftJoin(inventoryMaster, eq(inventoryMaster.productId, productMaster.id))
          .where(and(eq(productMaster.tenantId, tenantId), sql`${inventoryMaster.safetyStockBuffer} > 0`))
          .groupBy(productMaster.sourceChannel),
      ]);

      const driftByProduct = new Map<string, { channel: string | null; diff: number | null }>();
      const driftProductIdsByChannel: Record<string, Set<string>> = { base: new Set(), ebay: new Set() };
      for (const row of unresolvedDrift) {
        if (!row.productId) continue;
        const payload = row.payload as { liveQuantity?: number; expectedQuantity?: number } | null;
        const diff =
          payload && typeof payload.liveQuantity === "number" && typeof payload.expectedQuantity === "number"
            ? payload.liveQuantity - payload.expectedQuantity
            : null;
        if (!driftByProduct.has(row.productId)) driftByProduct.set(row.productId, { channel: row.channel, diff });
        if (row.channel === "base" || row.channel === "ebay") driftProductIdsByChannel[row.channel]!.add(row.productId);
      }
      const doubleSaleProductIds = new Set(unresolvedDoubleSale.map((r) => r.productId).filter((id): id is string => Boolean(id)));
      const doubleSaleProductIdsByChannel: Record<string, Set<string>> = { base: new Set(), ebay: new Set() };
      for (const row of unresolvedDoubleSale) {
        if (row.productId && (row.channel === "base" || row.channel === "ebay")) doubleSaleProductIdsByChannel[row.channel]!.add(row.productId);
      }
      const safetyStockCountByChannel: Record<string, number> = { base: 0, ebay: 0 };
      let safetyStockCountCentral = 0;
      for (const row of safetyStockBySourceChannel) {
        safetyStockCountCentral += row.count;
        // A source channel never has safety stock withheld from it (calculateChannelAvailableQuantity)
        // -- only the *other* channel does.
        if (row.sourceChannel === "base") safetyStockCountByChannel.ebay! += row.count;
        else if (row.sourceChannel === "ebay") safetyStockCountByChannel.base! += row.count;
      }

      const conditions = [eq(productMaster.tenantId, tenantId)];
      if (statusParsed.success) conditions.push(eq(productMaster.status, statusParsed.data));
      if (channelParsed.success) conditions.push(eq(productMaster.sourceChannel, channelParsed.data));
      if (q) {
        const searchCondition = or(ilike(productMaster.title, `%${q}%`), ilike(productMaster.sku, `%${q}%`));
        if (searchCondition) conditions.push(searchCondition);
      }
      // A left join, not inner -- a product with no eBay listing yet must still appear.
      // Safe against row fan-out: channel_listings has a unique (product_id, channel) index,
      // so this join can add at most one row per product. Same reasoning for inventoryMaster
      // (product_id is its own primary key -- a strict 1:1 with product_master).
      const ebayJoin = and(eq(channelListings.productId, productMaster.id), eq(channelListings.channel, "ebay"));
      if (syncStatus) conditions.push(eq(channelListings.status, syncStatus));
      if (diffStatus === "possible_double_sale") {
        conditions.push(doubleSaleProductIds.size > 0 ? inArray(productMaster.id, [...doubleSaleProductIds]) : sql`false`);
      } else if (diffStatus === "attention") {
        const ids = [...driftByProduct.keys()].filter((id) => !doubleSaleProductIds.has(id));
        conditions.push(ids.length > 0 ? inArray(productMaster.id, ids) : sql`false`);
      } else if (diffStatus === "sold_out") {
        conditions.push(eq(inventoryMaster.soldOut, true));
      }
      const whereClause = and(...conditions);

      const [rows, totalRows, published, draft, soldOut, needsAttention, catalogTotal, baseConfidence, ebayConfidence] = await Promise.all([
        db
          .select({ product: productMaster, ebayListing: channelListings, inventoryRow: inventoryMaster })
          .from(productMaster)
          .leftJoin(channelListings, ebayJoin)
          .leftJoin(inventoryMaster, eq(inventoryMaster.productId, productMaster.id))
          .where(whereClause)
          .orderBy(desc(productMaster.updatedAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(productMaster)
          .leftJoin(channelListings, ebayJoin)
          .leftJoin(inventoryMaster, eq(inventoryMaster.productId, productMaster.id))
          .where(whereClause),
        countChannelListingsByStatus(db, tenantId, "ebay", "published"),
        countProductsByStatus(db, tenantId, "ai_generated"),
        countProductsByStatus(db, tenantId, "sold_out"),
        countChannelListingsByStatus(db, tenantId, "ebay", "error"),
        countProducts(db, tenantId),
        computeSyncConfidence(db, tenantId, "base"),
        computeSyncConfidence(db, tenantId, "ebay"),
      ]);

      const productIds = rows.map((r) => r.product.id);
      const [inventories, draftCountRows] = await Promise.all([
        Promise.all(rows.map((r) => getInventoryBreakdown(db, tenantId, r.product.id))),
        productIds.length
          ? db
              .select({ productId: aiListingDraft.productId, count: sql<number>`count(*)::int` })
              .from(aiListingDraft)
              .where(and(eq(aiListingDraft.tenantId, tenantId), inArray(aiListingDraft.productId, productIds)))
              .groupBy(aiListingDraft.productId)
          : [],
      ]);
      const draftCountByProduct = Object.fromEntries(draftCountRows.map((d) => [d.productId, d.count]));

      function diffStatusForProduct(productId: string): { code: string; diff: number | null } {
        if (doubleSaleProductIds.has(productId)) return { code: "possible_double_sale", diff: null };
        const drift = driftByProduct.get(productId);
        if (drift) return { code: classifyInventoryDiffMagnitude(drift.diff ?? 0), diff: drift.diff };
        return { code: "normal", diff: 0 };
      }

      const doubleSaleCentralCount = doubleSaleProductIds.size;
      const driftCentralCount = driftByProduct.size;
      const diffCentralCount = new Set([...driftByProduct.keys(), ...doubleSaleProductIds]).size;

      function healthBucket(channel: "base" | "ebay" | "central") {
        const doubleSale = channel === "central" ? doubleSaleCentralCount : doubleSaleProductIdsByChannel[channel]!.size;
        const drift =
          channel === "central"
            ? driftCentralCount
            : [...driftProductIdsByChannel[channel]!].filter((id) => !doubleSaleProductIdsByChannel[channel]!.has(id)).length;
        const safetyStock = channel === "central" ? safetyStockCountCentral : safetyStockCountByChannel[channel]!;
        // soldOut is reused as-is across all three rows (a product out of central stock is out
        // of stock everywhere) -- not independently tracked per channel anywhere in this schema.
        // normal is a non-negative remainder, not an independently-fetched set, so an unlikely
        // overlap (e.g. a product both drift-flagged AND sold out) is undercounted here rather
        // than double-subtracted -- documented approximation, not a fabricated number.
        const normal = Math.max(0, catalogTotal - doubleSale - drift - soldOut - safetyStock);
        return { normal, safetyStock, drift, possibleDoubleSale: doubleSale, soldOut, total: catalogTotal };
      }

      const trendSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const trendRows = await db
        .select({ errorCode: syncErrors.errorCode, createdAt: syncErrors.createdAt })
        .from(syncErrors)
        .where(
          and(
            eq(syncErrors.tenantId, tenantId),
            inArray(syncErrors.errorCode, ["inventory_drift", "possible_double_sale"]),
            gte(syncErrors.createdAt, trendSince),
          ),
        );
      const trendByDay = new Map<string, { diffCount: number; possibleDoubleSaleCount: number }>();
      for (const row of trendRows) {
        const day = row.createdAt.toISOString().slice(0, 10);
        const bucket = trendByDay.get(day) ?? { diffCount: 0, possibleDoubleSaleCount: 0 };
        if (row.errorCode === "possible_double_sale") bucket.possibleDoubleSaleCount += 1;
        else bucket.diffCount += 1;
        trendByDay.set(day, bucket);
      }
      const inventoryTrend = Array.from({ length: 7 }, (_, i) => {
        const date = new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const bucket = trendByDay.get(date) ?? { diffCount: 0, possibleDoubleSaleCount: 0 };
        return { date, ...bucket };
      });

      return json(200, {
        products: rows.map((r, i) => ({
          id: r.product.id,
          sku: r.product.sku,
          title: r.product.title,
          sourceChannel: r.product.sourceChannel,
          status: r.product.status,
          images: r.product.images,
          priceJpy: r.product.priceJpy,
          costJpy: r.product.costJpy,
          ebayListingStatus: r.ebayListing?.status ?? null,
          inventory: inventories[i],
          safetyStockBuffer: r.inventoryRow?.safetyStockBuffer ?? 0,
          diffStatus: diffStatusForProduct(r.product.id),
          lastSyncedAt: r.ebayListing?.lastSyncedAt?.toISOString() ?? null,
          aiDraftCount: draftCountByProduct[r.product.id] ?? 0,
          updatedAt: r.product.updatedAt.toISOString(),
        })),
        total: totalRows[0]?.count ?? 0,
        kpi: { total: catalogTotal, published, draft, soldOut, needsAttention },
        // Additive, 在庫監視-page-specific aggregates -- independent of `kpi` above, which the
        // existing /products page already relies on and must keep meaning exactly what it did.
        inventoryKpi: {
          monitored: catalogTotal,
          diffCount: diffCentralCount,
          safetyStockAppliedCount: safetyStockCountCentral,
          possibleDoubleSaleCount: doubleSaleCentralCount,
          reconstructPendingCount: driftCentralCount,
          syncedRate: Math.round((baseConfidence.score + ebayConfidence.score) / 2),
        },
        inventoryHealthByChannel: { base: healthBucket("base"), ebay: healthBucket("ebay"), central: healthBucket("central") },
        inventoryTrend,
      });
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
      // The AI draft (English title/description/item specifics) was previously never
      // returned to the frontend at all -- the products page could only blindly approve
      // or reject, never actually show a human what the AI generated. Included here,
      // additively, rather than as a separate route, since every caller of this existing
      // endpoint already wants "everything about this one product."
      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      return json(200, { product, listings, inventory, draft: draft ?? null });
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

    // Surfaces the exact same required-aspects check ebay-sync-worker runs at actual
    // publish time (findMissingRequiredAspects/applyStandardAspectFallbacks in
    // packages/core), but *before* the human clicks approve rather than only after an
    // async publish job has already failed. Read-only; never blocks approval itself --
    // the admin UI decides what to do with a non-empty missingAspects list.
    if (method === "GET" && /^\/admin\/products\/[^/]+\/preflight-check$/.test(path)) {
      const id = path.split("/")[3]!;
      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      const primaryCategory = draft.categoryCandidates[0];
      if (!primaryCategory) return json(200, { missingAspects: [], categoryId: null });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const requiredAspects = await adapter.getRequiredItemAspects(appAccessToken, primaryCategory.ebayCategoryId);
      const itemSpecifics = applyStandardAspectFallbacks(draft.itemSpecifics, requiredAspects);
      const missingAspects = findMissingRequiredAspects(itemSpecifics, requiredAspects);

      return json(200, { categoryId: primaryCategory.ebayCategoryId, missingAspects });
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

    // Lets a human fill in a required eBay item specific the AI draft left blank (the
    // guardrail in packages/ai correctly refuses to invent a value it has no real source
    // for -- see applyStandardAspectFallbacks's own doc comment on why only Brand gets an
    // automatic "Unbranded" fallback). Mirrors draft-condition's shape; only ever adds or
    // corrects entries the human explicitly provides, never removes ones it doesn't
    // mention, and never touches the generated title/description text.
    if (method === "POST" && /^\/admin\/products\/[^/]+\/draft-item-specifics$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { itemSpecifics?: Record<string, string | null> };
      if (!body.itemSpecifics || typeof body.itemSpecifics !== "object") {
        return json(400, { error: "itemSpecifics_required" });
      }

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      const merged = { ...draft.itemSpecifics, ...body.itemSpecifics };
      await db.update(aiListingDraft).set({ itemSpecifics: merged }).where(eq(aiListingDraft.id, draft.id));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ai_draft_item_specifics_corrected",
        entityType: "ai_listing_draft",
        entityId: draft.id,
        before: { itemSpecifics: draft.itemSpecifics },
        after: { itemSpecifics: merged },
      });

      return json(200, { productId: id, itemSpecifics: merged });
    }

    // --- AI出品下書き画面: the review queue's own list + KPI row. Scoped to products still
    // in "ai_generated" status (not yet approved) -- once approved, a product moves on to
    // active/sold_out and drops out of this queue, matching the page's own purpose ("レビュ
    // ー待ちの下書きを確認・承認する"), not a general history of every draft ever generated
    // (that's what 監査ログ is for). ---
    if (method === "GET" && path === "/admin/drafts") {
      const needsReviewOnly = event.queryStringParameters?.status === "needs_review";
      const sortAsc = event.queryStringParameters?.sort === "created_asc";
      const fromRaw = event.queryStringParameters?.from;
      const toRaw = event.queryStringParameters?.to;
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      const q = event.queryStringParameters?.q?.trim().toLowerCase();

      // Bounded the same way /admin/products is (limit 200, no pagination) -- a review
      // queue of pending AI drafts is expected to stay small; this is the size a normal
      // catalog's ai_generated backlog looks like, not the full product catalog.
      const pendingProducts = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.status, "ai_generated")))
        .orderBy(desc(productMaster.updatedAt))
        .limit(200);
      const productById = new Map(pendingProducts.map((p) => [p.id, p]));

      // One row per product -- the most recent draft, in case a product has been
      // regenerated more than once. selectDistinctOn requires its own ORDER BY to start
      // with the DISTINCT ON column(s) (a Postgres requirement, not a drizzle quirk).
      const latestDrafts = pendingProducts.length
        ? await db
            .selectDistinctOn([aiListingDraft.productId])
            .from(aiListingDraft)
            .where(and(eq(aiListingDraft.tenantId, tenantId), inArray(aiListingDraft.productId, [...productById.keys()])))
            .orderBy(aiListingDraft.productId, desc(aiListingDraft.createdAt))
        : [];

      let rows = latestDrafts
        .map((draft) => {
          const product = productById.get(draft.productId);
          if (!product) return null;
          return { draft, product };
        })
        .filter((r): r is { draft: (typeof latestDrafts)[number]; product: (typeof pendingProducts)[number] } => r !== null);

      if (needsReviewOnly) rows = rows.filter((r) => r.draft.needsHumanReview);
      if (from) rows = rows.filter((r) => r.draft.createdAt >= from);
      if (to) rows = rows.filter((r) => r.draft.createdAt <= to);
      if (q) rows = rows.filter((r) => r.product.title.toLowerCase().includes(q) || r.product.sku.toLowerCase().includes(q));
      rows.sort((a, b) => (sortAsc ? 1 : -1) * (a.draft.createdAt.getTime() - b.draft.createdAt.getTime()));

      // KPI row: independent of the filters above, same "stays constant while the list
      // below is filtered" design as the products page's KPI row.
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const [reviewPending, needsFixRows, publishedTodayRow] = await Promise.all([
        countProductsByStatus(db, tenantId, "ai_generated"),
        Promise.resolve(latestDrafts.filter((d) => d.needsHumanReview).length),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(channelListings)
          .where(
            and(
              eq(channelListings.tenantId, tenantId),
              eq(channelListings.channel, "ebay"),
              eq(channelListings.status, "published"),
              gte(channelListings.lastSyncedAt, todayStart),
            ),
          ),
      ]);
      const avgConfidence =
        latestDrafts.length > 0
          ? Math.round(
              (latestDrafts.reduce((sum, d) => sum + draftConfidenceScore(d.confidenceFlags), 0) / latestDrafts.length) * 10,
            ) / 10
          : 0;

      return json(200, {
        drafts: rows.map(({ draft, product }) => ({
          id: draft.id,
          productId: product.id,
          title: product.title,
          sku: product.sku,
          images: product.images,
          categoryLabel: draft.categoryCandidates[0]?.label ?? null,
          confidenceScore: draftConfidenceScore(draft.confidenceFlags),
          needsHumanReview: draft.needsHumanReview,
          sourceMismatch: draft.sourceContentHash !== product.contentHash,
          createdAt: draft.createdAt.toISOString(),
        })),
        kpi: {
          reviewPending,
          needsFix: needsFixRows,
          publishedToday: publishedTodayRow[0]?.count ?? 0,
          avgConfidence,
        },
      });
    }

    // AI出品下書き画面 (item request): lets a human correct the AI's suggested USD price
    // before approval -- mirrors draft-condition's shape exactly. Stored in cents like the
    // column itself (suggested_price_usd_cents); the request body is dollars, matching what
    // every other USD-cents field in this API already accepts from the frontend.
    if (method === "POST" && /^\/admin\/products\/[^/]+\/draft-price$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { suggestedPriceUsd?: number };
      if (typeof body.suggestedPriceUsd !== "number" || !Number.isFinite(body.suggestedPriceUsd) || body.suggestedPriceUsd <= 0) {
        return json(400, { error: "invalid_price" });
      }
      const priceUsdCents = Math.round(body.suggestedPriceUsd * 100);

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      await db.update(aiListingDraft).set({ suggestedPriceUsd: priceUsdCents }).where(eq(aiListingDraft.id, draft.id));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ai_draft_price_corrected",
        entityType: "ai_listing_draft",
        entityId: draft.id,
        before: { suggestedPriceUsdCents: draft.suggestedPriceUsd },
        after: { suggestedPriceUsdCents: priceUsdCents },
      });

      // Cents, like every other read of this same column (e.g. GET /admin/products/{id}'s
      // raw draft.suggestedPriceUsd) -- the request body above is dollars (a human-facing
      // input field), but every value this API returns over the wire for this column stays
      // in the column's real unit so the frontend divides by 100 in exactly one place.
      return json(200, { productId: id, suggestedPriceUsdCents: priceUsdCents });
    }

    // AI出品下書き画面: the SEO keyword chips are fully replaced by whatever list the
    // operator saves (unlike draft-item-specifics' merge-by-key semantics) -- there's no
    // stable "key" to merge keyword entries by, and the frontend always sends its own
    // current, complete chip list back.
    if (method === "POST" && /^\/admin\/products\/[^/]+\/draft-seo-keywords$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { seoKeywords?: unknown };
      if (!Array.isArray(body.seoKeywords) || !body.seoKeywords.every((k) => typeof k === "string")) {
        return json(400, { error: "seoKeywords_required" });
      }
      const seoKeywords = [...new Set(body.seoKeywords.map((k) => k.trim()).filter(Boolean))];

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      await db.update(aiListingDraft).set({ seoKeywords }).where(eq(aiListingDraft.id, draft.id));

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ai_draft_seo_keywords_corrected",
        entityType: "ai_listing_draft",
        entityId: draft.id,
        before: { seoKeywords: draft.seoKeywords },
        after: { seoKeywords },
      });

      return json(200, { productId: id, seoKeywords });
    }

    // AI出品下書き画面: free-text internal note ("作業メモ") -- never sent to eBay, purely
    // for the admin team. No before/after diff worth recording in the audit log (unlike the
    // other draft-* routes' structured fields, an arbitrary text note isn't meaningfully
    // diffable there), so this just updates the row.
    if (method === "POST" && /^\/admin\/products\/[^/]+\/draft-notes$/.test(path)) {
      const id = path.split("/")[3]!;
      const body = JSON.parse(event.body ?? "{}") as { internalNotes?: string | null };
      if (body.internalNotes !== null && typeof body.internalNotes !== "string") {
        return json(400, { error: "internalNotes_required" });
      }

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      const internalNotes = body.internalNotes?.trim() || null;
      await db.update(aiListingDraft).set({ internalNotes }).where(eq(aiListingDraft.id, draft.id));

      return json(200, { productId: id, internalNotes });
    }

    if (method === "GET" && path === "/admin/sync-errors") {
      const resolvedOnly = event.queryStringParameters?.resolved === "true";
      const productId = event.queryStringParameters?.productId;
      // Additive left-joins for the チャネル同期 page's error table (product name/SKU, the
      // job type that failed) -- every existing field stays on the row unchanged (see the
      // {...r.error} spread below), so the original /sync-errors page keeps working exactly
      // as before against this same route.
      const rows = await db
        .select({ error: syncErrors, productTitle: productMaster.title, productSku: productMaster.sku, jobType: syncJobs.type })
        .from(syncErrors)
        .leftJoin(productMaster, eq(productMaster.id, syncErrors.productId))
        .leftJoin(syncJobs, eq(syncJobs.id, syncErrors.jobId))
        .where(
          productId
            ? and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.resolved, resolvedOnly), eq(syncErrors.productId, productId))
            : and(eq(syncErrors.tenantId, tenantId), eq(syncErrors.resolved, resolvedOnly)),
        )
        .orderBy(desc(syncErrors.createdAt))
        .limit(200);
      const syncErrorsOut = rows.map((r) => ({
        ...r.error,
        productTitle: r.productTitle ?? null,
        productSku: r.productSku ?? null,
        jobType: r.jobType ?? null,
      }));
      return json(200, { syncErrors: syncErrorsOut });
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
      // Idempotent: onboarding's own copy warns that re-running this duplicates the
      // policies on eBay's side, but nothing previously enforced that -- a second click
      // (or a second visit to this step after a reload, since policiesDone was a
      // client-only flag) created a second set every time. Persisted ids let this reuse
      // the existing ones instead of ever calling eBay's create endpoints twice.
      const [existing] = await db
        .select({
          ebayFulfillmentPolicyId: tenants.ebayFulfillmentPolicyId,
          ebayPaymentPolicyId: tenants.ebayPaymentPolicyId,
          ebayReturnPolicyId: tenants.ebayReturnPolicyId,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      if (existing?.ebayFulfillmentPolicyId) {
        return json(200, {
          fulfillmentPolicyId: existing.ebayFulfillmentPolicyId,
          paymentPolicyId: existing.ebayPaymentPolicyId,
          returnPolicyId: existing.ebayReturnPolicyId,
          alreadyConfigured: true,
        });
      }

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

      await db
        .update(tenants)
        .set({
          ebayFulfillmentPolicyId: fulfillmentPolicyId,
          ebayPaymentPolicyId: paymentPolicyId,
          ebayReturnPolicyId: returnPolicyId,
        })
        .where(eq(tenants.id, tenantId));

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

    if (method === "POST" && path === "/admin/ebay/platform-notification-setup") {
      const body = JSON.parse(event.body ?? "{}") as { alertEmail?: string };
      if (!body.alertEmail) return json(400, { error: "alertEmail_required" });

      const endpointBase = process.env.EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL;
      if (!endpointBase) return json(500, { error: "EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL_not_configured" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      // Requires this application's App ID to already be allow-listed by eBay for
      // OAuth-based Platform Notifications delivery -- see subscribeToFixedPriceTransactionNotifications.
      const [accountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });
      const userAccessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

      // Round 14 hardening ("eBay Platform Notification abuse対策" + "BOOTSTRAP_TENANT_ID
      //固定もマルチテナント設計上見直してください"): this delivery mechanism has no
      // per-request signature scheme at all, and its payload carries no tenant hint --
      // registering a per-tenant signed token in the destination URL itself is what fixes
      // both. eBay will faithfully re-POST to this exact URL (path segment and all) on
      // every future notification, so this mints it once here and the token verifies
      // (never expires -- there's no round trip to bound the age of) for the life of the
      // subscription.
      const token = signWebhookDestinationToken(creds.clientSecret, tenantId);
      const endpoint = `${endpointBase}/${token}`;

      await adapter.subscribeToFixedPriceTransactionNotifications(userAccessToken, endpoint, body.alertEmail);

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "ebay_platform_notification_subscribed",
        entityType: "ebay_account",
        entityId: accountId,
        after: { eventType: "FixedPriceTransaction" },
      });

      return json(201, { eventType: "FixedPriceTransaction" });
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
        descriptionHtml: string;
        images: string[];
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

          unmanaged.push({
            externalId: item.externalId,
            title: item.title,
            descriptionHtml: item.descriptionHtml,
            images: item.images,
            suggestedProductId,
            matchScore,
            matchReasons,
          });
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

    if (method === "POST" && /^\/admin\/products\/[^/]+\/apply-dynamic-price$/.test(path)) {
      // Commercial-readiness follow-up to the dynamic-price preview above: actually pushes
      // the recommended price to eBay, instead of leaving the operator to update it by hand.
      // Reuses the exact same path a normal content edit takes (writing suggestedPriceUsd
      // onto the AI draft, then an "ebay_update" sync job) rather than calling the eBay
      // adapter directly here, so the update still goes through ebay-sync-worker's existing
      // safety net (finalSafetyCheckForUpdate, price-anomaly detection, auto-rollback).
      const id = path.split("/")[3]!;
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.id, id)))
        .limit(1);
      if (!product) return json(404, { error: "product_not_found" });

      const [ebayListing] = await db
        .select()
        .from(channelListings)
        .where(
          and(eq(channelListings.tenantId, tenantId), eq(channelListings.productId, id), eq(channelListings.channel, "ebay")),
        )
        .limit(1);
      if (!ebayListing?.externalId || ebayListing.status !== "published") {
        return json(409, { error: "not_published_to_ebay" });
      }

      const [draft] = await db
        .select()
        .from(aiListingDraft)
        .where(and(eq(aiListingDraft.tenantId, tenantId), eq(aiListingDraft.productId, id)))
        .orderBy(desc(aiListingDraft.createdAt))
        .limit(1);
      if (!draft) return json(404, { error: "no_draft_for_product" });

      const fx = await fetchFxRate();
      const shippingUsd = product.shippingCostUsdCents !== null ? product.shippingCostUsdCents / 100 : DEFAULT_SHIPPING_USD;
      const targetMarginRatio =
        product.targetMarginBasisPoints !== null ? product.targetMarginBasisPoints / 10000 : DEFAULT_TARGET_MARGIN_RATIO;
      const price = computeDynamicPrice({
        costJpy: product.priceJpy,
        fxRateUsdPerJpy: fx.fxRateUsdPerJpy,
        shippingUsd,
        targetMarginRatio,
      });
      const suggestedPriceUsdCents = Math.round(price.recommendedPriceUsd * 100);

      await db.update(aiListingDraft).set({ suggestedPriceUsd: suggestedPriceUsdCents }).where(eq(aiListingDraft.id, draft.id));

      const queues = getQueueUrls();
      await enqueue(
        queues.ebaySync,
        { type: "ebay_update", tenantId, productId: id },
        `${tenantId}:ebay-update:${id}:apply-price-${suggestedPriceUsdCents}`,
      );

      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "dynamic_price_applied",
        entityType: "product",
        entityId: id,
        before: { suggestedPriceUsd: draft.suggestedPriceUsd },
        after: { suggestedPriceUsd: suggestedPriceUsdCents },
      });

      return json(202, { status: "update_queued", priceUsd: price.recommendedPriceUsd });
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
        // The corrected quantity directly addresses whatever this product's open
        // inventory_drift row(s) were reporting -- resolve them rather than leaving a
        // stale error sitting in the list after the operator just fixed its root cause.
        await db
          .update(syncErrors)
          .set({ resolved: true })
          .where(
            and(
              eq(syncErrors.tenantId, tenantId),
              eq(syncErrors.productId, id),
              eq(syncErrors.errorCode, "inventory_drift"),
              eq(syncErrors.resolved, false),
            ),
          );
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

      // The orders table only has product_id -- every other order-management screen this
      // platform has (commerce-dashboard, product detail) already joins in sku/title/images
      // for display, so the standalone order list does the same rather than making the
      // frontend show a bare UUID or fire one lookup per row.
      const productIds = [...new Set(orderRows.map((o) => o.productId))];
      const productRows = productIds.length
        ? await db
            .select({ id: productMaster.id, sku: productMaster.sku, title: productMaster.title, images: productMaster.images })
            .from(productMaster)
            .where(and(eq(productMaster.tenantId, tenantId), inArray(productMaster.id, productIds)))
        : [];
      const productById = new Map(productRows.map((p) => [p.id, p]));

      const enriched = orderRows.map((o) => ({ ...o, product: productById.get(o.productId) ?? null }));
      return json(200, { orders: enriched });
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

      // Phase 3 of the SaaS conversion ("plan quota enforcement"). Reserved atomically
      // before the OpenAI call (a separate check-then-increment pair left a real race
      // where two concurrent requests could both read the same pre-increment count and
      // both proceed, breaching the monthly limit); released again if the generation
      // attempt then fails, so a failed attempt never permanently consumes quota.
      const staleBilling = await getTenantBillingStatus(db, tenantId);
      const staleLimit = getPlanLimits(staleBilling?.plan ?? "standard").maxAiGenerationsPerMonth;
      const staleReserved = await tryReserveMonthlyAiGeneration(db, tenantId, staleLimit);
      if (!staleReserved) {
        return json(429, { error: "ai_quota_exceeded", limit: staleLimit });
      }

      const daysListed = Math.max(0, Math.floor((Date.now() - product.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
      const modelClient = createAIModelClient(process.env);
      let suggestion;
      try {
        suggestion = await suggestStaleProductImprovement(
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
      } catch (err) {
        await releaseMonthlyAiGenerationReservation(db, tenantId);
        throw err;
      }
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

      // Phase 3 of the SaaS conversion ("plan quota enforcement"). Reserved atomically
      // before the OpenAI call (a separate check-then-increment pair left a real race
      // where two concurrent requests could both read the same pre-increment count and
      // both proceed, breaching the monthly limit); released again if the generation
      // attempt then fails, so a failed attempt never permanently consumes quota.
      const snsBilling = await getTenantBillingStatus(db, tenantId);
      const snsLimit = getPlanLimits(snsBilling?.plan ?? "standard").maxAiGenerationsPerMonth;
      const snsReserved = await tryReserveMonthlyAiGeneration(db, tenantId, snsLimit);
      if (!snsReserved) {
        return json(429, { error: "ai_quota_exceeded", limit: snsLimit });
      }

      const modelClient = createAIModelClient(process.env);
      let saved;
      let script;
      try {
        script = await generateSnsScript(modelClient, {
          titleJa: product.title,
          descriptionJa: product.descriptionJa,
          brand: product.brand,
          material: product.material,
          sizeLabel: product.sizeLabel,
          priceJpy: product.priceJpy,
          imageCount: product.images.length,
        });
        const promptVersion = "sns-script-v1";
        saved = await upsertSnsScript(db, tenantId, id, script.scriptText, promptVersion);
      } catch (err) {
        await releaseMonthlyAiGenerationReservation(db, tenantId);
        throw err;
      }

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

    // Onboarding screen (apps/admin/app/onboarding): a simple, reliable "is this channel
    // connected yet" boolean -- computeChannelSyncState's HEALTHY/DEGRADED/... states are
    // about ongoing sync health, not "has this tenant ever connected an account", and are
    // not a safe stand-in for a brand-new tenant that hasn't connected anything at all.
    if (method === "GET" && path === "/admin/oauth/status") {
      const [baseAccountId] = await listConnectedAccountIds(db, tenantId, "base");
      const [ebayAccountId] = await listConnectedAccountIds(db, tenantId, "ebay");
      // Whether the onboarding wizard's own "eBayの事業者ポリシーを設定する" step has
      // already been completed -- read from where POST /admin/ebay/policies persists it,
      // so a page reload can tell this step is already done instead of resetting to
      // "not configured" (previously a client-only flag lost on every remount).
      const [tenantRow] = await db
        .select({ ebayFulfillmentPolicyId: tenants.ebayFulfillmentPolicyId })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      return json(200, {
        base: Boolean(baseAccountId),
        ebay: Boolean(ebayAccountId),
        ebayPoliciesConfigured: Boolean(tenantRow?.ebayFulfillmentPolicyId),
      });
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

    // --- チャネル同期 round: 接続詳細・同期ジョブキュー・パイプライン ---
    // Deliberately a NEW route rather than extending GET /admin/oauth/status -- that route's
    // { base: boolean, ebay: boolean, ebayPoliciesConfigured } shape is already relied on by
    // /onboarding and /commerce, and this page needs a much richer per-channel payload
    // (token expiry, last-synced time, derived sync state) that would be a breaking shape
    // change for those existing callers.

    if (method === "GET" && path === "/admin/sync/connections") {
      async function connectionDetail(channel: "base" | "ebay") {
        const [connection] = await db
          .select()
          .from(oauthConnections)
          .where(and(eq(oauthConnections.tenantId, tenantId), eq(oauthConnections.channel, channel)))
          .orderBy(desc(oauthConnections.updatedAt))
          .limit(1);
        const [lastSyncedAt, syncState] = await Promise.all([
          getLatestSyncedAt(db, tenantId, channel),
          computeChannelSyncState(db, tenantId, channel),
        ]);
        return {
          connected: Boolean(connection),
          externalAccountId: connection?.externalAccountId ?? null,
          expiresAt: connection?.expiresAt?.toISOString() ?? null,
          lastSyncedAt: lastSyncedAt?.toISOString() ?? null,
          state: syncState.state,
          reasons: syncState.reasons,
        };
      }
      const [base, ebay] = await Promise.all([connectionDetail("base"), connectionDetail("ebay")]);
      return json(200, { base, ebay });
    }

    // sync_jobs is the Transactional Outbox table (see product-fetch's insertOutboxJob /
    // dispatchPendingOutboxJobs and packages/db's applySaleWithOutbox) -- it only ever holds
    // rows of type "ai_generate", "ebay_update", or "channel_inventory_push", and its status
    // only ever becomes "pending" -> "completed" (dispatched to SQS) or "failed" (dispatch
    // failed); workers never write back a "processing"/"succeeded" status here (that would be
    // this row's own downstream SQS consumer's job, which this table does not track). Bounded
    // list rather than true pagination, same convention as GET /admin/sync-errors, since a
    // healthy tenant's outbox queue is small by nature (num_pending items, single digits to
    // low hundreds -- never a full product-catalog-sized dataset).
    if (method === "GET" && path === "/admin/sync/jobs") {
      const statusFilter = event.queryStringParameters?.status;
      const rows = await db
        .select()
        .from(syncJobs)
        .where(eq(syncJobs.tenantId, tenantId))
        .orderBy(desc(syncJobs.updatedAt))
        .limit(200);

      const productIds = [...new Set(rows.map((r) => r.productId).filter((id): id is string => Boolean(id)))];
      const products = productIds.length
        ? await db
            .select({ id: productMaster.id, title: productMaster.title, sku: productMaster.sku })
            .from(productMaster)
            .where(and(eq(productMaster.tenantId, tenantId), inArray(productMaster.id, productIds)))
        : [];
      const productById = new Map(products.map((p) => [p.id, p]));

      // Counts reflect the full fetched set, independent of statusFilter -- so switching
      // status tabs never makes the tab counts themselves jump around.
      const counts = {
        all: rows.length,
        pending: rows.filter((r) => r.status === "pending").length,
        completed: rows.filter((r) => r.status === "completed").length,
        failed: rows.filter((r) => r.status === "failed").length,
      };

      const jobs = rows
        .filter((r) => !statusFilter || r.status === statusFilter)
        .map((r) => ({
          id: r.id,
          type: r.type,
          productId: r.productId,
          productTitle: r.productId ? (productById.get(r.productId)?.title ?? null) : null,
          productSku: r.productId ? (productById.get(r.productId)?.sku ?? null) : null,
          status: r.status,
          attempts: r.attempts,
          idempotencyKey: r.idempotencyKey,
          payload: r.payload,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }));

      return json(200, { jobs, counts });
    }

    // Resets a failed outbox row back to "pending" so the next dispatchPendingOutboxJobs poll
    // (product-fetch, every 15min) picks it back up -- the same thing that already happens to
    // every failed row automatically; this just lets an operator ask for it explicitly and see
    // it reflected immediately, rather than waiting for the next scheduled poll.
    if (method === "POST" && /^\/admin\/sync\/jobs\/[^/]+\/retry$/.test(path)) {
      const id = path.split("/")[4]!;
      const [job] = await db
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.tenantId, tenantId), eq(syncJobs.id, id)))
        .limit(1);
      if (!job) return json(404, { error: "not_found" });
      if (job.status !== "failed") return json(400, { error: "job_not_failed" });

      await db.update(syncJobs).set({ status: "pending", updatedAt: new Date() }).where(eq(syncJobs.id, id));
      await recordAuditLog(db, {
        tenantId,
        actor: actorFromEvent(event),
        action: "sync_job_retried",
        entityType: "sync_job",
        entityId: id,
      });
      return json(200, { status: "pending" });
    }

    if (method === "POST" && path === "/admin/sync/jobs/bulk-retry") {
      const body = JSON.parse(event.body ?? "{}") as { ids?: unknown };
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
      if (ids.length === 0) return json(400, { error: "ids_required" });

      const failedJobs = await db
        .select()
        .from(syncJobs)
        .where(and(eq(syncJobs.tenantId, tenantId), inArray(syncJobs.id, ids), eq(syncJobs.status, "failed")));

      for (const row of failedJobs) {
        await db.update(syncJobs).set({ status: "pending", updatedAt: new Date() }).where(eq(syncJobs.id, row.id));
        await recordAuditLog(db, {
          tenantId,
          actor: actorFromEvent(event),
          action: "sync_job_retried",
          entityType: "sync_job",
          entityId: row.id,
        });
      }
      return json(200, { retried: failedJobs.length });
    }

    // Real per-stage counts for the selected date range, built from data this platform
    // already records -- never a guessed/simulated queue-depth number:
    //  - 取得: product_master rows touched by a BASE fetch in the window (source-of-truth for
    //    "how much did we pull from BASE", since product-fetch itself keeps no fetch log).
    //  - 変換: ai_listing_draft rows created in the window (AI turning BASE content into
    //    eBay-ready listing content is literally what this stage is).
    //  - 公開: channel_listings rows that reached eBay status=published with a lastSyncedAt in
    //    the window (mirrors the drafts page's own "today公開" KPI, generalized to a range).
    // "pending" on 変換/公開 is the CURRENT outbox backlog for that stage's job type(s), not
    // range-scoped (a backlog is a right-now fact, not a historical one). 取得 has no queue --
    // BASE import runs synchronously per poll -- so it reports no pending count.
    if (method === "GET" && path === "/admin/sync/pipeline") {
      const fromParam = event.queryStringParameters?.from;
      const toParam = event.queryStringParameters?.to;
      const from = fromParam ? new Date(fromParam) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const to = toParam ? new Date(toParam) : new Date();

      const [fetchedRows, transformedRows, publishedRows, pendingTransform, pendingPublish] = await Promise.all([
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(productMaster)
          .where(and(eq(productMaster.tenantId, tenantId), gte(productMaster.updatedAt, from), lte(productMaster.updatedAt, to))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(aiListingDraft)
          .where(and(eq(aiListingDraft.tenantId, tenantId), gte(aiListingDraft.createdAt, from), lte(aiListingDraft.createdAt, to))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(channelListings)
          .where(
            and(
              eq(channelListings.tenantId, tenantId),
              eq(channelListings.channel, "ebay"),
              eq(channelListings.status, "published"),
              gte(channelListings.lastSyncedAt, from),
              lte(channelListings.lastSyncedAt, to),
            ),
          ),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(syncJobs)
          .where(and(eq(syncJobs.tenantId, tenantId), eq(syncJobs.type, "ai_generate"), eq(syncJobs.status, "pending"))),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(syncJobs)
          .where(
            and(
              eq(syncJobs.tenantId, tenantId),
              inArray(syncJobs.type, ["ebay_update", "channel_inventory_push"]),
              eq(syncJobs.status, "pending"),
            ),
          ),
      ]);

      return json(200, {
        from: from.toISOString(),
        to: to.toISOString(),
        fetched: { count: fetchedRows[0]?.count ?? 0 },
        transformed: { count: transformedRows[0]?.count ?? 0, pending: pendingTransform[0]?.count ?? 0 },
        published: { count: publishedRows[0]?.count ?? 0, pending: pendingPublish[0]?.count ?? 0 },
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

          const ebayListing = listings.find((l) => l.channel === "ebay");

          return {
            productId: product.id,
            sku: product.sku,
            title: product.title,
            status: product.status,
            images: product.images,
            channelStatus: Object.fromEntries(listings.map((l) => [l.channel, l.status])),
            lastSyncedAt: Object.fromEntries(listings.map((l) => [l.channel, l.lastSyncedAt?.toISOString() ?? null])),
            // The price this platform actually last pushed to eBay -- the real "current
            // price" to compare a fresh AI suggestion against, not the recommendation's own
            // theoretical baseline. Null until a first successful sync has ever happened.
            currentEbayPriceUsdCents:
              ebayListing?.lastSyncedPriceJpy != null ? Math.round(ebayListing.lastSyncedPriceJpy * usdPerJpy * 100) : null,
            inventory: breakdown,
            // Nullable, not defaulted to 0 -- a product whose cost was never entered has no
            // cost data at all, distinct from one that genuinely cost nothing (see
            // product_master.cost_jpy's own schema comment). The commerce page sums this
            // across products that do have it and discloses which ones don't, rather than
            // silently treating "unknown" as "free" in an aggregate total.
            costUsdCents: typeof product.costJpy === "number" ? Math.round(product.costJpy * usdPerJpy * 100) : null,
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

      // Dashboard KPI row (UI): a real rolling 24h window, distinct from the calendar-day
      // trend buckets above -- computed from relevantOrders (already covers this range,
      // since `since` is always at least a full month back) rather than a separate query.
      const last24hStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const last24hOrders = relevantOrders.filter((o) => o.placedAt >= last24hStart);
      const last24h = {
        revenueUsdCents: last24hOrders.reduce((sum, o) => sum + profitFor(o).revenueUsdCents, 0),
        orderCount: last24hOrders.length,
      };

      // "公開中eBay出品数" KPI: a real count, not the commerce-dashboard's per-product N+1
      // breakdown (that endpoint answers a different question -- this dashboard just needs
      // the one number).
      const ebayPublishedCount = await countChannelListingsByStatus(db, tenantId, "ebay", "published");

      // Per-channel "最終同期" timestamp for the sync-topology card, from the same table's
      // own bookkeeping (channel_listings.last_synced_at) rather than a guessed cadence.
      const lastSyncedRows = await db
        .select({ channel: channelListings.channel, lastSyncedAt: sql<string | null>`max(${channelListings.lastSyncedAt})` })
        .from(channelListings)
        .where(eq(channelListings.tenantId, tenantId))
        .groupBy(channelListings.channel);
      const lastSyncedByChannel = Object.fromEntries(lastSyncedRows.map((r) => [r.channel, r.lastSyncedAt]));

      return json(200, {
        currentMonth: summarize(currentMonthOrders),
        previousMonth: summarize(previousMonthOrders),
        trend,
        recentOrders,
        inventory: { totalAvailable, lowStockCount },
        last24h,
        ebayPublishedCount,
        lastSyncedAt: { base: lastSyncedByChannel.base ?? null, ebay: lastSyncedByChannel.ebay ?? null },
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
