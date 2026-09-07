import { createAIModelClient, generateEbayListing } from "@ai-ec/ai";
import { buildIdempotencyKey, getPlanLimits, withIdempotency } from "@ai-ec/core";
import {
  aiListingDraft,
  channelListings,
  getMonthlyAiGenerationCount,
  getTenantBillingStatus,
  incrementMonthlyAiGenerationCount,
  productMaster,
} from "@ai-ec/db";
import { getDb, getIdempotencyStore, recordAuditLog, recordSyncError } from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface AiGenerateMessage {
  type: "ai_generate";
  tenantId: string;
  productId: string;
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const modelClient = createAIModelClient(process.env);

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as AiGenerateMessage;
    const idempotencyStore = getIdempotencyStore(message.tenantId);

    try {
      const [product] = await db
        .select()
        .from(productMaster)
        .where(and(eq(productMaster.tenantId, message.tenantId), eq(productMaster.id, message.productId)))
        .limit(1);
      if (!product) throw new Error(`product_master row not found for id ${message.productId}`);

      // Phase 3 of the SaaS conversion ("plan quota enforcement"). Checked before the
      // idempotency-guarded OpenAI call, not after, so a tenant already at quota never
      // incurs the AI spend just to have its result discarded. Not pushed to `failures`
      // below -- this isn't a retryable error, retrying won't help until next month.
      const billing = await getTenantBillingStatus(db, message.tenantId);
      const used = await getMonthlyAiGenerationCount(db, message.tenantId);
      const limit = getPlanLimits(billing?.plan ?? "standard").maxAiGenerationsPerMonth;
      if (used >= limit) {
        await recordSyncError(db, {
          tenantId: message.tenantId,
          channel: "ebay",
          productId: message.productId,
          errorCode: "ai_quota_exceeded",
          errorMessage: `Tenant has reached its plan's monthly AI generation limit (${limit})`,
          payload: { messageId: record.messageId, used, limit },
        });
        continue;
      }

      const key = buildIdempotencyKey(message.tenantId, ["ai_generate", product.id, product.contentHash]);

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
          tenantId: message.tenantId,
          productId: product.id,
          sourceContentHash: product.contentHash,
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
          .values({ tenantId: message.tenantId, productId: product.id, channel: "ebay", status: "pending_approval" })
          .onConflictDoNothing({ target: [channelListings.productId, channelListings.channel] });

        await db.update(productMaster).set({ status: "ai_generated", updatedAt: new Date() }).where(eq(productMaster.id, product.id));

        await recordAuditLog(db, {
          tenantId: message.tenantId,
          actor: "system:ai-generate-worker",
          action: "ai_listing_generated",
          entityType: "product",
          entityId: product.id,
          after: { needsHumanReview: listing.needsHumanReview, titleEn: listing.titleEn },
        });

        await incrementMonthlyAiGenerationCount(db, message.tenantId);

        return listing;
      });
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError") {
        await recordSyncError(db, {
          tenantId: message.tenantId,
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
