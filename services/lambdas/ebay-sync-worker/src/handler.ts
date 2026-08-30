import type { EbayAdapter } from "@ai-ec/adapter-ebay";
import { buildIdempotencyKey, withIdempotency } from "@ai-ec/core";
import { aiListingDraft, channelListings, inventoryMaster, productMaster } from "@ai-ec/db";
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

async function publish(db: ReturnType<typeof getDb>, adapter: EbayAdapter, accessToken: string, productId: string) {
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

  const { externalId } = await adapter.createListing(accessToken, {
    productId,
    sku: product.sku,
    titleEn: draft.titleEn,
    descriptionHtmlEn: draft.descriptionHtmlEn,
    priceUsd: Math.round(priceUsd * 100) / 100,
    quantity: inventory?.quantity ?? 0,
    images: product.images,
    categoryId: primaryCategory.ebayCategoryId,
    itemSpecifics: draft.itemSpecifics,
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

async function update(
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

  await adapter.updateListing(accessToken, externalId, {
    titleEn: draft?.titleEn,
    descriptionHtmlEn: draft?.descriptionHtmlEn,
    images: product.images,
    priceUsd: draft?.suggestedPriceUsd ? draft.suggestedPriceUsd / 100 : undefined,
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
