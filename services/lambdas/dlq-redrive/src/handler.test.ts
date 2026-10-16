import { beforeEach, describe, expect, it, vi } from "vitest";

const redriveDlqMock = vi.fn();
const redriveDlqSelectivelyMock = vi.fn();
const isEbayProductSyncRetryableMock = vi.fn();
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const getDbMock = vi.fn(() => ({}));

vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: () => getDbMock(),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  redriveDlq: (...args: unknown[]) => redriveDlqMock(...args),
  redriveDlqSelectively: (...args: unknown[]) => redriveDlqSelectivelyMock(...args),
  isEbayProductSyncRetryable: (...args: unknown[]) => isEbayProductSyncRetryableMock(...args),
}));

const { handler } = await import("./handler.js");

const ENV_KEYS = [
  "AI_GENERATE_DLQ_URL",
  "AI_GENERATE_DLQ_ARN",
  "EBAY_SYNC_DLQ_URL",
  "EBAY_SYNC_DLQ_ARN",
  "EBAY_SYNC_QUEUE_URL",
  "INVENTORY_SYNC_DLQ_URL",
  "INVENTORY_SYNC_DLQ_ARN",
  "EBAY_SYNC_AUTO_REDRIVE_ENABLED",
] as const;

describe("dlq-redrive handler", () => {
  beforeEach(() => {
    redriveDlqMock.mockReset();
    redriveDlqSelectivelyMock.mockReset();
    isEbayProductSyncRetryableMock.mockReset();
    recordAuditLogMock.mockClear();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("redrives AI_GENERATE/INVENTORY_SYNC wholesale and records an audit log entry only for the ones it actually started", async () => {
    process.env.AI_GENERATE_DLQ_URL = "ai-generate-dlq-url";
    process.env.AI_GENERATE_DLQ_ARN = "ai-generate-dlq-arn";
    process.env.INVENTORY_SYNC_DLQ_URL = "inventory-sync-dlq-url";
    process.env.INVENTORY_SYNC_DLQ_ARN = "inventory-sync-dlq-arn";

    redriveDlqMock.mockResolvedValueOnce({ started: true, taskHandle: "task-1" }).mockResolvedValueOnce({ started: false });

    await handler();

    expect(redriveDlqMock).toHaveBeenCalledTimes(2);
    expect(redriveDlqMock).toHaveBeenCalledWith("ai-generate-dlq-url", "ai-generate-dlq-arn");
    expect(redriveDlqMock).toHaveBeenCalledWith("inventory-sync-dlq-url", "inventory-sync-dlq-arn");
    expect(recordAuditLogMock).toHaveBeenCalledTimes(1);
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "dlq_redrive_started", entityId: "AI_GENERATE" }),
    );
    // eBay no longer goes through this wholesale path at all -- see the selective-redrive
    // tests below.
    expect(redriveDlqSelectivelyMock).not.toHaveBeenCalled();
  });

  it("skips a queue whose DLQ env vars are not configured", async () => {
    process.env.AI_GENERATE_DLQ_URL = "ai-generate-dlq-url";
    process.env.AI_GENERATE_DLQ_ARN = "ai-generate-dlq-arn";

    redriveDlqMock.mockResolvedValueOnce({ started: false });

    await handler();

    expect(redriveDlqMock).toHaveBeenCalledTimes(1);
  });

  it("never touches the eBay DLQ while EBAY_SYNC_AUTO_REDRIVE_ENABLED is unset", async () => {
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_DLQ_ARN = "ebay-sync-dlq-arn";
    process.env.EBAY_SYNC_QUEUE_URL = "ebay-sync-queue-url";

    await handler();

    expect(redriveDlqSelectivelyMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("never touches the eBay DLQ when its source queue URL is not configured, even if enabled", async () => {
    process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED = "true";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    // EBAY_SYNC_QUEUE_URL deliberately left unset

    await handler();

    expect(redriveDlqSelectivelyMock).not.toHaveBeenCalled();
  });

  it("selectively redrives the eBay DLQ when enabled, classifying each message by its own sync_errors history", async () => {
    process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED = "true";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_QUEUE_URL = "ebay-sync-queue-url";

    redriveDlqSelectivelyMock.mockImplementationOnce(async (_dlqUrl: string, _sourceUrl: string, isRetryable: (body: string) => Promise<boolean>) => {
      isEbayProductSyncRetryableMock.mockResolvedValueOnce(true);
      const retryable = await isRetryable(JSON.stringify({ tenantId: "tenant-a", productId: "product-1" }));
      expect(retryable).toBe(true);
      expect(isEbayProductSyncRetryableMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "product-1");
      return { redriven: 1, skipped: 0 };
    });

    await handler();

    expect(redriveDlqSelectivelyMock).toHaveBeenCalledWith("ebay-sync-dlq-url", "ebay-sync-queue-url", expect.any(Function));
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "dlq_redrive_selective", entityId: "EBAY_SYNC", after: { redriven: 1, skipped: 0 } }),
    );
  });

  it("fails open (treats as retryable) when a DLQ message body can't be parsed", async () => {
    process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED = "true";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_QUEUE_URL = "ebay-sync-queue-url";

    redriveDlqSelectivelyMock.mockImplementationOnce(async (_dlqUrl: string, _sourceUrl: string, isRetryable: (body: string) => Promise<boolean>) => {
      const retryable = await isRetryable("not json");
      expect(retryable).toBe(true);
      expect(isEbayProductSyncRetryableMock).not.toHaveBeenCalled();
      return { redriven: 0, skipped: 0 };
    });

    await handler();
  });

  it("does not record an audit log entry when nothing was redriven or skipped", async () => {
    process.env.EBAY_SYNC_AUTO_REDRIVE_ENABLED = "true";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_QUEUE_URL = "ebay-sync-queue-url";
    redriveDlqSelectivelyMock.mockResolvedValueOnce({ redriven: 0, skipped: 0 });

    await handler();

    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("still recovers unrelated AI and inventory queues even while the eBay DLQ is held for seller-setup messages", async () => {
    process.env.AI_GENERATE_DLQ_URL = "ai-generate-dlq-url";
    process.env.AI_GENERATE_DLQ_ARN = "ai-generate-dlq-arn";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_DLQ_ARN = "ebay-sync-dlq-arn";
    process.env.INVENTORY_SYNC_DLQ_URL = "inventory-sync-dlq-url";
    process.env.INVENTORY_SYNC_DLQ_ARN = "inventory-sync-dlq-arn";
    redriveDlqMock.mockResolvedValue({ started: false });

    await handler();

    expect(redriveDlqMock).toHaveBeenCalledTimes(2);
    expect(redriveDlqMock).toHaveBeenCalledWith("ai-generate-dlq-url", "ai-generate-dlq-arn");
    expect(redriveDlqMock).toHaveBeenCalledWith("inventory-sync-dlq-url", "inventory-sync-dlq-arn");
    expect(redriveDlqSelectivelyMock).not.toHaveBeenCalled(); // EBAY_SYNC_AUTO_REDRIVE_ENABLED unset
  });
});
