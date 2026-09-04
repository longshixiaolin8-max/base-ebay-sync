import { EbayPartialUpdateRolledBackError, type EbayAdapter } from "@ai-ec/adapter-ebay";
import { buildIdempotencyKey, findMissingRequiredAspects, withIdempotency } from "@ai-ec/core";
import {
  aiListingDraft,
  calculateChannelAvailableQuantity,
  channelListings,
  computeDynamicSafetyStock,
  computeSyncConfidence,
  detectInventoryAnomaly,
  detectPriceAnomaly,
  inventoryMaster,
  predictStockoutRisk,
  PREEMPTIVE_STOCKOUT_BUFFER,
  productMaster,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  enqueue,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  recordSyncError,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import { desc, eq, and } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface EbaySyncMessage {
  type: "ebay_publish" | "ebay_update";
  productId: string;
}

const USD_PER_JPY_FALLBACK = 0.0067; // used only if the AI draft has no suggestedPriceUsd

/**
 * Below this eBay sync-confidence score (see computeSyncConfidence), new publishes are
 * paused -- item #4 of the hardening list ("信頼度が低い時だけ出品数を制限"). Existing
 * listings still get their price/quantity/condition updates either way: pausing those too
 * would let real drift (a sellout, a price change) go unreflected while eBay is already
 * unreliable, making things worse rather than safer.
 */
const SYNC_CONFIDENCE_PUBLISH_THRESHOLD = 40;

/**
 * Item #2 of the hardening list ("動的安全在庫"): recomputes and persists the product's
 * safety-stock buffer from real sales velocity + eBay sync confidence (see
 * computeDynamicSafetyStock) on every sync cycle, rather than trusting a value someone
 * set by hand once.
 *
 * Also applies item #5 of the second hardening round ("予測型在庫制御"): on top of that
 * buffer, withholds one extra unit specifically for a product whose current sales pace
 * would sell it out within days (see predictStockoutRisk) -- not every product, only the
 * ones actually at risk, since a slow-moving item doesn't need the extra caution.
 *
 * Returns the freshly-computed total buffer so the caller doesn't need to re-read the row
 * it just wrote.
 */
async function resolveSafetyStockBuffer(db: ReturnType<typeof getDb>, productId: string): Promise<number> {
  const { recommendedBuffer } = await computeDynamicSafetyStock(db, productId, "ebay");
  const risk = await predictStockoutRisk(db, productId);
  const totalBuffer = recommendedBuffer + (risk.highRisk ? PREEMPTIVE_STOCKOUT_BUFFER : 0);
  await db
    .update(inventoryMaster)
    .set({ safetyStockBuffer: totalBuffer, updatedAt: new Date() })
    .where(eq(inventoryMaster.productId, productId));
  return totalBuffer;
}

/**
 * Item #5 of the hardening list ("AI誤出品防止Gate"): before pushing an AI draft to eBay,
 * verifies it was actually generated from the product's *current* content. product_master's
 * contentHash covers title/description/price/images together, so any change to any of them
 * since the draft was written makes them diverge — the draft's title/description/condition/
 * item specifics may no longer describe the real product. Rather than trying to fuzzy-match
 * text (unreliable and itself a source of false confidence), this reuses the exact hash this
 * platform already computes and compares elsewhere (product-fetch's own no-op detection),
 * so "does the draft still match?" is an objective yes/no, not a guess.
 *
 * On a mismatch: halts (throws, blocking this publish/update) and enqueues a fresh
 * ai_generate job so a matching draft exists for the *next* attempt -- "自動停止・再生成".
 */
async function enforceContentConsistency(
  db: ReturnType<typeof getDb>,
  product: { id: string; contentHash: string },
  draft: { sourceContentHash: string } | undefined,
): Promise<void> {
  if (draft && draft.sourceContentHash === product.contentHash) return;

  const queues = getQueueUrls();
  await enqueue(queues.aiGenerate, { type: "ai_generate", productId: product.id }, `ai-generate:${product.id}:${product.contentHash}`);

  await recordAuditLog(db, {
    actor: "system:ebay-sync-worker",
    action: "ai_draft_stale_regeneration_triggered",
    entityType: "product",
    entityId: product.id,
    before: { draftSourceContentHash: draft?.sourceContentHash ?? null },
    after: { currentContentHash: product.contentHash },
  });

  throw new Error(
    `AI draft for product ${product.id} no longer matches the product's current content ` +
      `(BASE title/description/price/images changed since the draft was generated). ` +
      `Blocking this eBay sync and enqueuing regeneration; retry once the new draft is approved.`,
  );
}

/**
 * Item #1 of the second hardening round ("異常検知 -- 通常と違う在庫変動・価格変動・
 * 大量注文を自動検知して同期を一時停止"). Checks the product's recent inventory activity
 * (mass orders, an abnormally large single sale, a suspicious BASE stock swing — see
 * detectInventoryAnomaly) and the price about to be pushed to eBay against the last price
 * actually synced there (detectPriceAnomaly). Either one blocks the sync — better to pause
 * and let a human look than to propagate what might be corrupted source data or a burst that
 * looks more like fraud/error than organic demand.
 */
async function enforceAnomalyFree(
  db: ReturnType<typeof getDb>,
  productId: string,
  candidatePriceJpy: number,
  lastSyncedPriceJpy: number | null,
): Promise<void> {
  const inventoryCheck = await detectInventoryAnomaly(db, productId);
  const priceCheck = detectPriceAnomaly(lastSyncedPriceJpy, candidatePriceJpy);
  const reasons = [...inventoryCheck.reasons, ...(priceCheck.reason ? [priceCheck.reason] : [])];
  if (reasons.length === 0) return;

  await recordAuditLog(db, {
    actor: "system:ebay-sync-worker",
    action: "anomaly_detected_sync_paused",
    entityType: "product",
    entityId: productId,
    after: { reasons },
  });

  throw new Error(
    `Sync paused for product ${productId}: unusual activity detected (${reasons.join("; ")}). ` +
      `Retry once the underlying data looks normal again.`,
  );
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const idempotencyStore = getIdempotencyStore();
  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  const adapter = createEbayAdapter(creds);
  const [accountId] = await listConnectedAccountIds(db, "ebay");

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as EbaySyncMessage;

    try {
      if (!accountId) throw new Error("No eBay account connected — complete eBay OAuth first");
      const accessToken = await getValidAccessToken(db, adapter, accountId);

      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, message.productId)).limit(1);
      if (!product) throw new Error(`product_master row not found for id ${message.productId}`);

      const [listing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.productId, product.id), eq(channelListings.channel, "ebay")))
        .limit(1);
      if (!listing) throw new Error(`No eBay channel_listings row for product ${product.id}`);

      if (message.type === "ebay_publish") {
        const key = buildIdempotencyKey(["ebay_publish", product.id, product.contentHash]);
        await withIdempotency(idempotencyStore, key, () => publish(db, adapter, accessToken, product.id));
      } else {
        const key = buildIdempotencyKey(["ebay_update", product.id, product.contentHash]);
        await withIdempotency(idempotencyStore, key, () =>
          update(db, adapter, accessToken, product.id, listing.externalId!),
        );
      }
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError") {
        await recordSyncError(db, {
          channel: "ebay",
          productId: message.productId,
          errorCode: `${message.type}_failed`,
          errorMessage: error.message,
          payload: { messageId: record.messageId },
        });
        await db
          .update(channelListings)
          .set({ status: "error", lastError: error.message, updatedAt: new Date() })
          .where(and(eq(channelListings.productId, message.productId), eq(channelListings.channel, "ebay")));
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

export async function publish(db: ReturnType<typeof getDb>, adapter: EbayAdapter, accessToken: string, productId: string) {
  const confidence = await computeSyncConfidence(db, "ebay");
  if (confidence.score < SYNC_CONFIDENCE_PUBLISH_THRESHOLD) {
    throw new Error(
      `eBay sync confidence too low to publish new listings (score ${confidence.score}/100 over the last ` +
        `${confidence.windowHours}h: ${confidence.successCount} synced / ${confidence.failureCount} failed, ` +
        `${confidence.outOfOrderEventCount}/${confidence.totalEventCount} inventory events out of order). ` +
        `Publishing is paused until sync quality recovers; existing listings still receive updates.`,
    );
  }

  const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
  if (!product) throw new Error(`product not found: ${productId}`);

  const [draft] = await db
    .select()
    .from(aiListingDraft)
    .where(eq(aiListingDraft.productId, productId))
    .orderBy(desc(aiListingDraft.createdAt))
    .limit(1);
  if (!draft) throw new Error(`no AI listing draft found for product ${productId}`);

  await enforceContentConsistency(db, product, draft);

  const [listing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")))
    .limit(1);
  await enforceAnomalyFree(db, productId, product.priceJpy, listing?.lastSyncedPriceJpy ?? null);

  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);

  const priceUsd = draft.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : product.priceJpy * USD_PER_JPY_FALLBACK;
  const primaryCategory = draft.categoryCandidates[0];
  if (!primaryCategory) throw new Error(`AI draft for product ${productId} has no category candidate`);

  const safetyStockBuffer = inventory ? await resolveSafetyStockBuffer(db, productId) : 0;
  const availableQuantity = calculateChannelAvailableQuantity(
    inventory?.quantity ?? 0,
    safetyStockBuffer,
    "ebay",
    product.sourceChannel,
  );

  // Verify the draft's itemSpecifics against eBay's own real, per-category required aspects
  // before spending a publish attempt on it — the check itself is a live API call, never a
  // guessed/hardcoded requirements list, consistent with this platform's "never assert
  // unverified facts" principle applied to our own preflight logic too.
  const appAccessToken = await adapter.getApplicationAccessToken();
  const requiredAspects = await adapter.getRequiredItemAspects(appAccessToken, primaryCategory.ebayCategoryId);
  const missingAspects = findMissingRequiredAspects(draft.itemSpecifics, requiredAspects);
  if (missingAspects.length > 0) {
    throw new Error(
      `AI draft for product ${productId} is missing eBay-required item specifics for category ` +
        `${primaryCategory.ebayCategoryId} (${primaryCategory.label}): ${missingAspects.join(", ")}`,
    );
  }

  const { externalId } = await adapter.createListing(accessToken, {
    productId,
    sku: product.sku,
    titleEn: draft.titleEn,
    descriptionHtmlEn: draft.descriptionHtmlEn,
    priceUsd: Math.round(priceUsd * 100) / 100,
    quantity: availableQuantity,
    images: product.images,
    categoryId: primaryCategory.ebayCategoryId,
    itemSpecifics: draft.itemSpecifics,
    condition: draft.condition,
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
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")));

  await db.update(productMaster).set({ status: "active", updatedAt: new Date() }).where(eq(productMaster.id, productId));

  await recordAuditLog(db, {
    actor: "system:ebay-sync-worker",
    action: "ebay_listing_published",
    entityType: "product",
    entityId: productId,
    after: { externalId, priceUsd },
  });
}

export async function update(
  db: ReturnType<typeof getDb>,
  adapter: EbayAdapter,
  accessToken: string,
  productId: string,
  externalId: string,
) {
  const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
  if (!product) throw new Error(`product not found: ${productId}`);

  const [draft] = await db
    .select()
    .from(aiListingDraft)
    .where(eq(aiListingDraft.productId, productId))
    .orderBy(desc(aiListingDraft.createdAt))
    .limit(1);

  await enforceContentConsistency(db, product, draft);

  const [listing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")))
    .limit(1);
  await enforceAnomalyFree(db, productId, product.priceJpy, listing?.lastSyncedPriceJpy ?? null);

  // Also re-syncs quantity (with the safety-stock buffer applied) on every content update —
  // previously only the initial publish ever pushed a quantity, so a BASE restock after
  // publish never reached eBay at all.
  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  const availableQuantity = inventory
    ? calculateChannelAvailableQuantity(
        inventory.quantity,
        await resolveSafetyStockBuffer(db, productId),
        "ebay",
        product.sourceChannel,
      )
    : undefined;

  try {
    await adapter.updateListing(accessToken, externalId, {
      titleEn: draft?.titleEn,
      descriptionHtmlEn: draft?.descriptionHtmlEn,
      images: product.images,
      priceUsd: draft?.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : undefined,
      quantity: availableQuantity,
      condition: draft?.condition,
      // Always resend the draft's item specifics, not just when they change -- eBay's PUT
      // inventory_item is a full replace, so relying on EbayAdapter's "carry over the
      // current value" fallback alone means a required aspect wiped by any earlier failed
      // PUT never gets restored. The DB draft is the source of truth here.
      itemSpecifics: draft?.itemSpecifics,
    });
  } catch (err) {
    if (err instanceof EbayPartialUpdateRolledBackError) {
      // Item #3 of the second hardening round ("自動ロールバック"): the adapter already
      // reverted eBay's live listing content back to its prior state. Record that it
      // happened; this update attempt still counts as failed and flows through the same
      // sync_errors/retry path as any other update failure below.
      await recordAuditLog(db, {
        actor: "system:ebay-sync-worker",
        action: "auto_rollback_applied",
        entityType: "product",
        entityId: productId,
        after: { reason: err.message },
      });
    }
    throw err;
  }

  await db
    .update(channelListings)
    .set({
      lastSyncedAt: new Date(),
      lastError: null,
      lastSyncedPriceJpy: product.priceJpy,
      updatedAt: new Date(),
    })
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")));

  await recordAuditLog(db, {
    actor: "system:ebay-sync-worker",
    action: "ebay_listing_updated",
    entityType: "product",
    entityId: productId,
  });
}
