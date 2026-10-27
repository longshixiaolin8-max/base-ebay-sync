import {
  buildIdempotencyKey,
  computeDynamicPrice,
  DEFAULT_SHIPPING_USD,
  DEFAULT_TARGET_MARGIN_RATIO,
  finalSafetyCheckForNewListing,
  finalSafetyCheckForUpdate,
  withIdempotency,
} from "@ai-ec/core";
import {
  aiListingDraft,
  calculateChannelAvailableQuantity,
  channelListings,
  inventoryMaster,
  isChannelIsolated,
  productMaster,
} from "@ai-ec/db";
import {
  createShopifyAdapter,
  fetchFxRate,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  recordSyncError,
  type ShopifyAppCredentials,
} from "@ai-ec/lambda-shared";
import { and, desc, eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface ShopifySyncMessage {
  type: "shopify_publish" | "shopify_update";
  tenantId: string;
  productId: string;
}

const USD_PER_JPY_FALLBACK = 0.0067; // last-resort rate if the real FX API call itself fails

/** Same shape as ebay-sync-worker's own computeFallbackPriceUsd -- channel-agnostic (reads
 *  only product-level cost/shipping/margin fields), duplicated rather than shared because
 *  it's small and the two workers otherwise have no runtime dependency on each other. */
async function computeFallbackPriceUsd(
  product: { priceJpy: number; shippingCostUsdCents: number | null; targetMarginBasisPoints: number | null },
): Promise<number> {
  let fxRateUsdPerJpy = USD_PER_JPY_FALLBACK;
  try {
    fxRateUsdPerJpy = (await fetchFxRate()).fxRateUsdPerJpy;
  } catch {
    // Real FX API unreachable -- the static rate above is the documented last resort.
  }
  const shippingUsd = product.shippingCostUsdCents !== null ? product.shippingCostUsdCents / 100 : DEFAULT_SHIPPING_USD;
  const targetMarginRatio =
    product.targetMarginBasisPoints !== null ? product.targetMarginBasisPoints / 10000 : DEFAULT_TARGET_MARGIN_RATIO;
  return computeDynamicPrice({ costJpy: product.priceJpy, fxRateUsdPerJpy, shippingUsd, targetMarginRatio }).recommendedPriceUsd;
}

async function enforceChannelNotIsolated(db: ReturnType<typeof getDb>, tenantId: string): Promise<void> {
  const isolation = await isChannelIsolated(db, tenantId, "shopify");
  if (isolation.isolated) {
    throw new Error(`Shopify is currently isolated (${isolation.reasons.join("; ")}). Sync is paused until it recovers.`);
  }
}

/**
 * Deliberately much simpler than ebay-sync-worker's own publish()/update(): no business-
 * policy/category-required-aspects/sync-confidence/monthly-quota machinery -- none of that
 * hardening has a Shopify equivalent built yet (see docs/adding-a-channel.md). What it does
 * keep: tenant-isolation, the same AI listing draft every eBay listing already uses (no
 * separate "Shopify draft" generation step exists), the shared dynamic-price fallback, and
 * the same unconditional stage-3 finalSafetyCheck every other channel's publish/update goes
 * through right before the real API call.
 */
export async function publish(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  adapter: ReturnType<typeof createShopifyAdapter>,
  accessToken: string,
  productId: string,
): Promise<void> {
  await enforceChannelNotIsolated(db, tenantId);

  const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
  if (!product) throw new Error(`product not found: ${productId}`);

  const [draft] = await db
    .select()
    .from(aiListingDraft)
    .where(eq(aiListingDraft.productId, productId))
    .orderBy(desc(aiListingDraft.createdAt))
    .limit(1);
  if (!draft) throw new Error(`no AI listing draft found for product ${productId}`);

  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  const availableQuantity = calculateChannelAvailableQuantity(
    inventory?.quantity ?? 0,
    inventory?.safetyStockBuffer ?? 0,
    "shopify",
    product.sourceChannel,
  );

  const priceUsd = draft.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : await computeFallbackPriceUsd(product);

  const listingPayload = {
    titleEn: draft.titleEn,
    descriptionHtmlEn: draft.descriptionHtmlEn,
    priceUsd: Math.round(priceUsd * 100) / 100,
    quantity: availableQuantity,
    images: product.images,
    // Shopify has no category/item-specifics concept this adapter's createListing reads --
    // these two exist purely to satisfy finalSafetyCheckForNewListing's shared, channel-
    // agnostic "every field present" invariant below (the same stage-3 check every other
    // channel's publish goes through), not because Shopify uses them.
    categoryId: draft.categoryCandidates[0]?.label ?? "general",
    condition: draft.condition,
  };
  const safetyCheck = finalSafetyCheckForNewListing(listingPayload);
  if (!safetyCheck.safe) {
    throw new Error(`Refusing to publish product ${productId} to Shopify: ${safetyCheck.violations.join("; ")}`);
  }

  const { externalId } = await adapter.createListing(accessToken, {
    productId,
    sku: product.sku,
    ...listingPayload,
    itemSpecifics: {},
  });

  await db
    .update(channelListings)
    .set({
      externalId,
      status: "published",
      lastSyncedAt: new Date(),
      lastError: null,
      lastSyncedPriceJpy: product.priceJpy,
      updatedAt: new Date(),
    })
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "shopify")));

  await recordAuditLog(db, {
    tenantId,
    actor: "system:shopify-sync-worker",
    action: "shopify_listing_published",
    entityType: "product",
    entityId: productId,
    after: { externalId, priceUsd },
  });
}

export async function update(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  adapter: ReturnType<typeof createShopifyAdapter>,
  accessToken: string,
  productId: string,
  externalId: string,
): Promise<void> {
  await enforceChannelNotIsolated(db, tenantId);

  const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
  if (!product) throw new Error(`product not found: ${productId}`);

  const [draft] = await db
    .select()
    .from(aiListingDraft)
    .where(eq(aiListingDraft.productId, productId))
    .orderBy(desc(aiListingDraft.createdAt))
    .limit(1);

  const updatePayload = {
    titleEn: draft?.titleEn,
    descriptionHtmlEn: draft?.descriptionHtmlEn,
    priceUsd: draft?.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : undefined,
  };
  const safetyCheck = finalSafetyCheckForUpdate(updatePayload);
  if (!safetyCheck.safe) {
    throw new Error(`Refusing to update product ${productId} on Shopify: ${safetyCheck.violations.join("; ")}`);
  }

  await adapter.updateListing(accessToken, externalId, updatePayload);

  await db
    .update(channelListings)
    .set({
      status: "published",
      lastSyncedAt: new Date(),
      lastError: null,
      lastSyncedPriceJpy: product.priceJpy,
      updatedAt: new Date(),
    })
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "shopify")));

  await recordAuditLog(db, {
    tenantId,
    actor: "system:shopify-sync-worker",
    action: "shopify_listing_updated",
    entityType: "product",
    entityId: productId,
  });
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const creds = await getAppCredentials<ShopifyAppCredentials>("shopify");

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as ShopifySyncMessage;
    const idempotencyStore = getIdempotencyStore(message.tenantId);

    try {
      const [accountId] = await listConnectedAccountIds(db, message.tenantId, "shopify");
      if (!accountId) throw new Error("No Shopify account connected — complete Shopify OAuth first");
      // accountId is this tenant's own shop domain (see oauth-shopify's callback) -- the
      // per-request instance createListing/updateListing need, unlike the shared, shop-less
      // singleton loadImplementedChannelAdapters() builds for inventory pushes.
      const adapter = createShopifyAdapter(creds, accountId);
      const accessToken = await getValidAccessToken(db, message.tenantId, adapter, accountId);

      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, message.tenantId), eq(productMaster.id, message.productId)))
        .limit(1);
      if (!product) throw new Error(`product_master row not found for id ${message.productId}`);

      const [listing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.productId, product.id), eq(channelListings.channel, "shopify")))
        .limit(1);
      if (!listing) throw new Error(`No Shopify channel_listings row for product ${product.id}`);

      if (message.type === "shopify_publish") {
        const key = buildIdempotencyKey(message.tenantId, ["shopify_publish", product.id, product.contentHash]);
        await withIdempotency(idempotencyStore, key, () => publish(db, message.tenantId, adapter, accessToken, product.id));
      } else {
        const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, product.id)).limit(1);
        const key = buildIdempotencyKey(message.tenantId, [
          "shopify_update",
          product.id,
          product.contentHash,
          inventory?.version ?? 0,
        ]);
        await withIdempotency(idempotencyStore, key, () =>
          update(db, message.tenantId, adapter, accessToken, product.id, listing.externalId!),
        );
      }
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError") {
        await recordSyncError(db, {
          tenantId: message.tenantId,
          channel: "shopify",
          productId: message.productId,
          errorCode: `${message.type}_failed`,
          errorMessage: error.message,
          payload: { messageId: record.messageId, retryable: true },
        });
        await db
          .update(channelListings)
          .set({ status: "error", lastError: error.message, updatedAt: new Date() })
          .where(and(eq(channelListings.productId, message.productId), eq(channelListings.channel, "shopify")));
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
