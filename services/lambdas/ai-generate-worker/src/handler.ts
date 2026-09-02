import { createAIModelClient, generateEbayListing } from "@ai-ec/ai";
import { buildIdempotencyKey, withIdempotency } from "@ai-ec/core";
import { aiListingDraft, channelListings, productMaster } from "@ai-ec/db";
import { getDb, getIdempotencyStore, recordAuditLog, recordSyncError } from "@ai-ec/lambda-shared";
import { eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface AiGenerateMessage {
  type: "ai_generate";
  productId: string;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const idempotencyStore = getIdempotencyStore();
  const modelClient = createAIModelClient(process.env);

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as AiGenerateMessage;

    try {
      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, message.productId)).limit(1);
      if (!product) throw new Error(`product_master row not found for id ${message.productId}`);

      const key = buildIdempotencyKey(["ai_generate", product.id, product.contentHash]);

      await withIdempotency(idempotencyStore, key, async () => {
        const listing = await generateEbayListing(modelClient, {
          titleJa: product.title,
          descriptionJa: product.descriptionJa,
          brand: product.brand,
          material: product.material,
          sizeLabel: product.sizeLabel,
          priceJpy: product.priceJpy,
          imageCount: product.images.length,
        });

        await db.insert(aiListingDraft).values({
          productId: product.id,
          titleEn: listing.titleEn,
          descriptionHtmlEn: listing.descriptionHtmlEn,
          categoryCandidates: listing.categoryCandidates,
          itemSpecifics: listing.itemSpecifics,
          condition: listing.condition,
          seoKeywords: listing.seoKeywords,
          suggestedPriceUsd: listing.suggestedPriceUsd ? Math.round(listing.suggestedPriceUsd * 100) : null,
          confidenceFlags: listing.confidenceFlags,
          needsHumanReview: listing.needsHumanReview,
          reviewNotes: listing.reviewNotes,
        });

        await db
          .insert(channelListings)
          .values({ productId: product.id, channel: "ebay", status: "pending_approval" })
          .onConflictDoNothing({ target: [channelListings.productId, channelListings.channel] });

        await db.update(productMaster).set({ status: "ai_generated", updatedAt: new Date() }).where(eq(productMaster.id, product.id));

        await recordAuditLog(db, {
          actor: "system:ai-generate-worker",
          action: "ai_listing_generated",
          entityType: "product",
          entityId: product.id,
          after: { needsHumanReview: listing.needsHumanReview, titleEn: listing.titleEn },
        });

        return listing;
      });
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError") {
        await recordSyncError(db, {
          channel: "ebay",
          productId: message.productId,
          errorCode: "ai_generate_failed",
          errorMessage: error.message,
          payload: { messageId: record.messageId },
        });
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  if (failures.length > 0) {
    return { batchItemFailures: failures };
  }
  return { batchItemFailures: [] };
};
