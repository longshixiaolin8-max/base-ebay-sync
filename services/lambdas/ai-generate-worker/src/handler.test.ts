import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IdempotencyStore } from "@ai-ec/core";
import type { SQSEvent } from "aws-lambda";

const generateEbayListingMock = vi.fn();
vi.mock("@ai-ec/ai", () => ({
  createAIModelClient: vi.fn(() => ({})),
  generateEbayListing: (...args: unknown[]) => generateEbayListingMock(...args),
}));

const getTenantBillingStatusMock = vi.fn().mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
const tryReserveMonthlyAiGenerationMock = vi.fn().mockResolvedValue(true);
const releaseMonthlyAiGenerationReservationMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/db", () => ({
  aiListingDraft: {},
  channelListings: { productId: "productId", channel: "channel" },
  productMaster: { id: "id" },
  getTenantBillingStatus: (...args: unknown[]) => getTenantBillingStatusMock(...args),
  tryReserveMonthlyAiGeneration: (...args: unknown[]) => tryReserveMonthlyAiGenerationMock(...args),
  releaseMonthlyAiGenerationReservation: (...args: unknown[]) => releaseMonthlyAiGenerationReservationMock(...args),
}));

const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);

function fakeIdempotencyStore(): IdempotencyStore {
  return {
    tryClaim: async () => null,
    complete: async () => undefined,
    fail: async () => undefined,
  };
}

vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: vi.fn(() => fakeDb),
  getIdempotencyStore: vi.fn(() => fakeIdempotencyStore()),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const PRODUCT = {
  id: "product-1",
  tenantId: "tenant-a",
  title: "T-Shirt",
  descriptionJa: "desc",
  brand: null,
  material: null,
  sizeLabel: null,
  priceJpy: 3000,
  images: ["https://img.example/1.jpg"],
  contentHash: "hash-1",
};

let fakeDb: ReturnType<typeof createFakeDb>;

function createFakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [PRODUCT],
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => undefined,
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => undefined,
      }),
    }),
  };
}

const { handler } = await import("./handler.js");

function sqsEvent(tenantId: string, productId: string, messageId = "msg-1"): SQSEvent {
  return {
    Records: [
      {
        messageId,
        body: JSON.stringify({ type: "ai_generate", tenantId, productId }),
      } as never,
    ],
  } as SQSEvent;
}

describe("ai-generate-worker handler", () => {
  beforeEach(() => {
    fakeDb = createFakeDb();
    generateEbayListingMock.mockReset().mockResolvedValue({
      titleEn: "T-Shirt",
      descriptionHtmlEn: "<p>desc</p>",
      categoryCandidates: [],
      itemSpecifics: {},
      condition: "NEW",
      seoKeywords: [],
      suggestedPriceUsd: null,
      confidenceFlags: {},
      needsHumanReview: true,
      reviewNotes: [],
    });
    getTenantBillingStatusMock.mockClear().mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
    tryReserveMonthlyAiGenerationMock.mockClear().mockResolvedValue(true);
    releaseMonthlyAiGenerationReservationMock.mockClear();
    recordAuditLogMock.mockClear();
    recordSyncErrorMock.mockClear();
  });

  it("reserves quota before generating and never releases it on success", async () => {
    const result = await handler(sqsEvent("tenant-a", "product-1"), {} as never, {} as never);

    expect(tryReserveMonthlyAiGenerationMock).toHaveBeenCalledWith(fakeDb, "tenant-a", 100);
    expect(generateEbayListingMock).toHaveBeenCalledTimes(1);
    expect(releaseMonthlyAiGenerationReservationMock).not.toHaveBeenCalled();
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("skips generation and records a sync error once the tenant is at its plan's monthly AI limit", async () => {
    tryReserveMonthlyAiGenerationMock.mockResolvedValue(false);

    const result = await handler(sqsEvent("tenant-a", "product-1"), {} as never, {} as never);

    expect(generateEbayListingMock).not.toHaveBeenCalled();
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tenantId: "tenant-a", errorCode: "ai_quota_exceeded" }),
    );
    // Not retryable until next month -- must not count as an SQS batch item failure.
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it("still generates when the reservation succeeds (just under the plan's monthly AI limit)", async () => {
    tryReserveMonthlyAiGenerationMock.mockResolvedValue(true);

    await handler(sqsEvent("tenant-a", "product-1"), {} as never, {} as never);

    expect(generateEbayListingMock).toHaveBeenCalledTimes(1);
  });

  it("releases the reservation and records a retryable sync error when generation fails after a successful reservation", async () => {
    generateEbayListingMock.mockRejectedValueOnce(new Error("model provider timed out"));

    const result = await handler(sqsEvent("tenant-a", "product-1"), {} as never, {} as never);

    expect(tryReserveMonthlyAiGenerationMock).toHaveBeenCalledTimes(1);
    expect(releaseMonthlyAiGenerationReservationMock).toHaveBeenCalledWith(fakeDb, "tenant-a");
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ tenantId: "tenant-a", errorCode: "ai_generate_failed" }),
    );
    // A genuine failure (not a quota block) should be retried -- counts as a batch item failure.
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-1" }] });
  });
});
