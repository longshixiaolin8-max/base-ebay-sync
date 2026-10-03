import { createAIModelClient, generateEbayListing } from "@ai-ec/ai";
import { buildIdempotencyKey, getPlanLimits, withIdempotency } from "@ai-ec/core";
import {
  aiListingDraft,
  channelListings,
  getTenantBillingStatus,
  productMaster,
  releaseMonthlyAiGenerationReservation,
  tryReserveMonthlyAiGeneration,
} from "@ai-ec/db";
import { getDb, getIdempotencyStore, recordAuditLog, recordSyncError } from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface AiGenerateMessage {
  type: "ai_generate";
  tenantId: string;
  productId: string;
}

/** Thrown inside the idempotency-guarded callback when tryReserveMonthlyAiGeneration
 *  refuses the reservation -- distinguishes "quota exhausted, not retryable until next
 *  month" from a genuine failure that should be retried. */
class AiQuotaExceededError extends Error {
  constructor(readonly limit: number) {
    super(`Tenant has reached its plan's monthly AI generation limit (${limit})`);
    this.name = "AiQuotaExceededError";
  }
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

      // Phase 3 of the SaaS conversion ("plan quota enforcement"). The reservation lives
      // *inside* the idempotency-guarded callback (right before the OpenAI call, so a
      // quota-blocked attempt never incurs the AI spend), not before withIdempotency is
      // called at all -- a genuine SQS redelivery of an already-completed generation
      // returns the cached result without ever re-running this callback, so keeping the
      // reservation here (as the old plain increment already did) avoids charging quota a
      // second time for the same logical generation. What changed is that the old
      // check-then-increment was two separate round-trips: two overlapping invocations for
      // *different* products of the same tenant could both read the same pre-increment
      // count and both proceed, breaching the monthly limit.
      // tryReserveMonthlyAiGeneration closes that race in one atomic statement; if the
      // generation attempt then fails, the reservation is released so a failed attempt
      // never permanently consumes quota.
      const billing = await getTenantBillingStatus(db, message.tenantId);
      const limit = getPlanLimits(billing?.plan ?? "standard").maxAiGenerationsPerMonth;
      const key = buildIdempotencyKey(message.tenantId, ["ai_generate", product.id, product.contentHash]);

      await withIdempotency(idempotencyStore, key, async () => {
        const reserved = await tryReserveMonthlyAiGeneration(db, message.tenantId, limit);
        if (!reserved) {
          throw new AiQuotaExceededError(limit);
        }

        try {
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

          return listing;
        } catch (err) {
          // The reservation above already consumed one unit of quota; refund it here so a
          // failed attempt (LLM error, guardrail rejection, DB write failure) isn't
          // charged against the tenant's monthly limit.
          await releaseMonthlyAiGenerationReservation(db, message.tenantId);
          throw err;
        }
      });
    } catch (err) {
      const error = err as Error;
      if (error instanceof AiQuotaExceededError) {
        // Not retryable until next month -- not pushed to `failures`, matching how this
        // was handled before (a quota-exceeded attempt was never counted as a batch failure).
        await recordSyncError(db, {
          tenantId: message.tenantId,
          channel: "ebay",
          productId: message.productId,
          errorCode: "ai_quota_exceeded",
          errorMessage: error.message,
          payload: { messageId: record.messageId, limit: error.limit },
        });
        continue;
      }
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
