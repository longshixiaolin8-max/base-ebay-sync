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
  enqueue,
  fetchFxRate,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
  getQueueUrls,
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
 * Found by Codex review: publish() checked only that a draft existed, never that it still
 * matched the product's *current* content -- unlike ebay-sync-worker's own
 * enforceContentConsistency, which this mirrors exactly (including the "自動停止・再生成"
 * block-and-regenerate behavior). Without it, a BASE title/description/price/image edit made
 * after the draft was generated but before Shopify approval would publish that stale,
 * possibly underpriced content with no warning. See ebay-sync-worker's own doc comment on
 * this same function for the full rationale; duplicated rather than shared since these two
 * workers have no other runtime dependency on each other.
 */
async function enforceContentConsistency(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  product: { id: string; contentHash: string },
  draft: { sourceContentHash: string },
): Promise<void> {
  if (draft.sourceContentHash === product.contentHash) return;

  const queues = getQueueUrls();
  await enqueue(
    queues.aiGenerate,
    { type: "ai_generate", tenantId, productId: product.id },
    `${tenantId}:ai-generate:${product.id}:${product.contentHash}`,
  );

  await recordAuditLog(db, {
    tenantId,
    actor: "system:shopify-sync-worker",
    action: "ai_draft_stale_regeneration_triggered",
    entityType: "product",
    entityId: product.id,
    before: { draftSourceContentHash: draft.sourceContentHash },
    after: { currentContentHash: product.contentHash },
  });

  throw new Error(
    `AI draft for product ${product.id} no longer matches the product's current content ` +
      `(BASE title/description/price/images changed since the draft was generated). ` +
      `Blocking this Shopify publish and enqueuing regeneration; retry once the new draft is approved.`,
  );
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
  await enforceContentConsistency(db, tenantId, product, draft);

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

  // Found by Codex review: this used to only ever push title/description/price, never
  // quantity -- updateListing() itself deliberately never applies `input.quantity` (price
  // lives on the variant, quantity needs the separate (inventory_item_id, location_id) call
  // setInventory makes; see client.ts's own comment). That left a BASE stock-only change
  // (restock, manual adjustment -- now routed here via product-fetch's own
  // propagateStockOnlyChangeToOtherChannels) with nowhere to actually reach Shopify: this
  // job type ran, "succeeded", and silently never touched inventory. Mirrors
  // ebay-sync-worker's own update(), which re-syncs quantity on every content update too, not
  // just at initial publish.
  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  if (inventory) {
    const availableQuantity = calculateChannelAvailableQuantity(
      inventory.quantity,
      inventory.safetyStockBuffer,
      "shopify",
      product.sourceChannel,
    );
    await adapter.setInventory(accessToken, externalId, availableQuantity);
  }

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
