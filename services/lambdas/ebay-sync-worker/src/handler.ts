import type { EbayAdapter } from "@ai-ec/adapter-ebay";
import { buildIdempotencyKey, findMissingRequiredAspects, withIdempotency } from "@ai-ec/core";
import {
  aiListingDraft,
  calculateChannelAvailableQuantity,
  channelListings,
  computeSyncConfidence,
  inventoryMaster,
  productMaster,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
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

  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);

  const priceUsd = draft.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : product.priceJpy * USD_PER_JPY_FALLBACK;
  const primaryCategory = draft.categoryCandidates[0];
  if (!primaryCategory) throw new Error(`AI draft for product ${productId} has no category candidate`);

  const availableQuantity = calculateChannelAvailableQuantity(
    inventory?.quantity ?? 0,
    inventory?.safetyStockBuffer ?? 0,
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
    .set({ externalId, status: "published", lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
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

  // Also re-syncs quantity (with the safety-stock buffer applied) on every content update —
  // previously only the initial publish ever pushed a quantity, so a BASE restock after
  // publish never reached eBay at all.
  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  const availableQuantity = inventory
    ? calculateChannelAvailableQuantity(inventory.quantity, inventory.safetyStockBuffer, "ebay", product.sourceChannel)
    : undefined;

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

  await db
    .update(channelListings)
    .set({ lastSyncedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")));

  await recordAuditLog(db, {
    actor: "system:ebay-sync-worker",
    action: "ebay_listing_updated",
    entityType: "product",
    entityId: productId,
  });
}
