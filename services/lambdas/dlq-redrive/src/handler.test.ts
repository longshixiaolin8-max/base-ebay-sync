import { beforeEach, describe, expect, it, vi } from "vitest";

const redriveDlqMock = vi.fn();
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const getDbMock = vi.fn(() => ({}));

vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: () => getDbMock(),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  redriveDlq: (...args: unknown[]) => redriveDlqMock(...args),
}));

const { handler } = await import("./handler.js");

const ENV_KEYS = [
  "AI_GENERATE_DLQ_URL",
  "AI_GENERATE_DLQ_ARN",
  "EBAY_SYNC_DLQ_URL",
  "EBAY_SYNC_DLQ_ARN",
  "INVENTORY_SYNC_DLQ_URL",
  "INVENTORY_SYNC_DLQ_ARN",
] as const;

describe("dlq-redrive handler", () => {
  beforeEach(() => {
    redriveDlqMock.mockReset();
    recordAuditLogMock.mockClear();
    for (const key of ENV_KEYS) delete process.env[key];
  });

  it("redrives every configured DLQ and records an audit log entry only for the ones it actually started", async () => {
    process.env.AI_GENERATE_DLQ_URL = "ai-generate-dlq-url";
    process.env.AI_GENERATE_DLQ_ARN = "ai-generate-dlq-arn";
    process.env.EBAY_SYNC_DLQ_URL = "ebay-sync-dlq-url";
    process.env.EBAY_SYNC_DLQ_ARN = "ebay-sync-dlq-arn";
    process.env.INVENTORY_SYNC_DLQ_URL = "inventory-sync-dlq-url";
    process.env.INVENTORY_SYNC_DLQ_ARN = "inventory-sync-dlq-arn";

    redriveDlqMock
      .mockResolvedValueOnce({ started: true, taskHandle: "task-1" }) // AI_GENERATE has messages
      .mockResolvedValueOnce({ started: false }) // EBAY_SYNC empty
      .mockResolvedValueOnce({ started: false }); // INVENTORY_SYNC empty

    await handler();

    expect(redriveDlqMock).toHaveBeenCalledTimes(3);
    expect(redriveDlqMock).toHaveBeenCalledWith("ai-generate-dlq-url", "ai-generate-dlq-arn");
    expect(recordAuditLogMock).toHaveBeenCalledTimes(1);
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "dlq_redrive_started", entityId: "AI_GENERATE" }),
    );
  });

  it("skips a queue whose DLQ env vars are not configured", async () => {
    process.env.AI_GENERATE_DLQ_URL = "ai-generate-dlq-url";
    process.env.AI_GENERATE_DLQ_ARN = "ai-generate-dlq-arn";
    // EBAY_SYNC / INVENTORY_SYNC left unset

    redriveDlqMock.mockResolvedValueOnce({ started: false });

    await handler();

    expect(redriveDlqMock).toHaveBeenCalledTimes(1);
  });
});
