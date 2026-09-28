import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppCredentialsMock = vi.fn();
const pollChannelSalesMock = vi.fn().mockResolvedValue(undefined);
const getDbMock = vi.fn(() => ({}));
const getQueueUrlsMock = vi.fn(() => ({ inventorySync: "inventory-sync-url" }));
const getApplicationAccessTokenMock = vi.fn().mockResolvedValue("app-token");
const getNotificationPublicKeyMock = vi.fn();
const createEbayAdapterMock = vi.fn((..._args: unknown[]) => ({
  channel: "ebay",
  getApplicationAccessToken: getApplicationAccessTokenMock,
  getNotificationPublicKey: getNotificationPublicKeyMock,
}));
const deleteOAuthConnectionsByExternalAccountMock = vi.fn().mockResolvedValue([]);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const recordSyncErrorMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: () => getDbMock(),
  getQueueUrls: () => getQueueUrlsMock(),
  pollChannelSales: (...args: unknown[]) => pollChannelSalesMock(...args),
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
  deleteOAuthConnectionsByExternalAccount: (...args: unknown[]) => deleteOAuthConnectionsByExternalAccountMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
}));

const computeChallengeResponseMock = vi.fn((..._args: unknown[]) => "computed-hash");
const parseSignatureHeaderMock = vi.fn();
const verifyNotificationSignatureMock = vi.fn();

vi.mock("@ai-ec/adapter-ebay", () => ({
  computeChallengeResponse: (...args: unknown[]) => computeChallengeResponseMock(...args),
  parseSignatureHeader: (...args: unknown[]) => parseSignatureHeaderMock(...args),
  verifyNotificationSignature: (...args: unknown[]) => verifyNotificationSignatureMock(...args),
}));

const { handler } = await import("./handler.js");

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: "/webhooks/ebay/notifications",
    rawQueryString: "",
    headers: {},
    requestContext: { http: { method: "GET" } },
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

describe("ebay-webhook handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    computeChallengeResponseMock.mockReturnValue("computed-hash");
    getAppCredentialsMock.mockResolvedValue({ webhookVerificationToken: "verify-me" });
    process.env.EBAY_WEBHOOK_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/notifications";
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValue([]);
    parseSignatureHeaderMock.mockReturnValue({ kid: "key-1" });
    getNotificationPublicKeyMock.mockResolvedValue({ algorithm: "ECDSA", digest: "SHA1", key: "pk" });
    verifyNotificationSignatureMock.mockReturnValue(true);
  });

  it("GET answers the challenge_code with the computed hash", async () => {
    const res = (await handler(
      makeEvent({ queryStringParameters: { challenge_code: "abc123" } }),
    )) as { statusCode: number; body?: string };

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ challengeResponse: "computed-hash" });
    expect(computeChallengeResponseMock).toHaveBeenCalledWith(
      "abc123",
      "verify-me",
      "https://api.example.com/webhooks/ebay/notifications",
    );
  });

  it("GET returns 400 when challenge_code is missing", async () => {
    const res = (await handler(makeEvent({ queryStringParameters: {} }))) as { statusCode: number };
    expect(res.statusCode).toBe(400);
  });

  it("POST with a valid signature triggers a scoped eBay sales poll and returns 204", async () => {
    parseSignatureHeaderMock.mockReturnValue({ kid: "key-1" });
    getNotificationPublicKeyMock.mockResolvedValue({ algorithm: "ECDSA", digest: "SHA1", key: "pk" });
    verifyNotificationSignatureMock.mockReturnValue(true);

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({ metadata: { topic: "LISTING" } }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(204);
    expect(pollChannelSalesMock).toHaveBeenCalledTimes(1);
  });

  it("POST with an invalid signature is rejected and does not trigger a poll", async () => {
    parseSignatureHeaderMock.mockReturnValue({ kid: "key-1" });
    getNotificationPublicKeyMock.mockResolvedValue({ algorithm: "ECDSA", digest: "SHA1", key: "pk" });
    verifyNotificationSignatureMock.mockReturnValue(false);

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: "{}",
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(412);
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
  });

  it("POST with no signature header is rejected", async () => {
    const res = (await handler(
      makeEvent({ requestContext: { http: { method: "POST" } } as never, headers: {}, body: "{}" }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(412);
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
  });

  it("POST with a MARKETPLACE_ACCOUNT_DELETION notification purges matching connections instead of polling", async () => {
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValue([
      { tenantId: "tenant-a", secretArn: "arn:aws:secretsmanager:secret-1" },
    ]);

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({
          metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
          notification: { data: { username: "closed-user-1", userId: "u-1" } },
        }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(204);
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
    expect(deleteOAuthConnectionsByExternalAccountMock).toHaveBeenCalledWith(expect.anything(), "ebay", "u-1");
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant-a",
        action: "ebay_account_deletion_purge",
        entityId: "u-1",
      }),
    );
  });

  it("purges by userId even when eBay omits username entirely (eBay's own Sept-2025 change for some regions)", async () => {
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValue([
      { tenantId: "tenant-a", secretArn: "arn:aws:secretsmanager:secret-1" },
    ]);

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({
          metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" },
          notification: { data: { userId: "u-2" } },
        }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(204);
    expect(deleteOAuthConnectionsByExternalAccountMock).toHaveBeenCalledWith(expect.anything(), "ebay", "u-2");
  });

  it("POST to the platform-notifications path triggers a sales poll and returns 200, regardless of body/signature", async () => {
    const res = (await handler(
      makeEvent({
        rawPath: "/webhooks/ebay/platform-notifications",
        requestContext: { http: { method: "POST" } } as never,
        headers: {},
        body: "<FixedPriceTransaction>...</FixedPriceTransaction>",
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(pollChannelSalesMock).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a MARKETPLACE_ACCOUNT_DELETION notification with no userId without purging anything", async () => {
    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: {} } }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(204);
    expect(deleteOAuthConnectionsByExternalAccountMock).not.toHaveBeenCalled();
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
  });

  it("purges only the matching connections when the same externalAccountId happens to span multiple tenants -- no other tenant's connection is touched", async () => {
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValue([
      { tenantId: "tenant-a", secretArn: "arn:aws:secretsmanager:secret-a" },
      { tenantId: "tenant-b", secretArn: "arn:aws:secretsmanager:secret-b" },
    ]);

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: { userId: "u-3" } } }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(204);
    // deleteOAuthConnectionsByExternalAccount itself is what scopes the DELETE by
    // (channel, externalAccountId) -- this only asserts the handler faithfully logs exactly
    // what it reports, once per affected tenant, never inventing or merging entries.
    expect(recordAuditLogMock).toHaveBeenCalledTimes(2);
    expect(recordAuditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "tenant-a", entityId: "u-3" }));
    expect(recordAuditLogMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tenantId: "tenant-b", entityId: "u-3" }));
  });

  it("重複notification idempotent: redelivering the same MARKETPLACE_ACCOUNT_DELETION notification is a safe no-op once nothing is left to purge", async () => {
    const body = JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: { userId: "u-4" } } });
    const event = makeEvent({
      requestContext: { http: { method: "POST" } } as never,
      headers: { "x-ebay-signature": "sig-header" },
      body,
    });

    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValueOnce([{ tenantId: "tenant-a", secretArn: "arn:...:s1" }]);
    const first = (await handler(event)) as { statusCode: number };

    // A redelivery finds nothing left to delete -- the real deleteOAuthConnectionsByExternalAccount
    // returns [] the second time (the row is already gone), which this mock reproduces.
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValueOnce([]);
    recordAuditLogMock.mockClear();
    const second = (await handler(event)) as { statusCode: number };

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(recordAuditLogMock).not.toHaveBeenCalled(); // nothing new to log on the redelivery
    expect(recordSyncErrorMock).not.toHaveBeenCalled();
  });

  it("returns a non-2xx and records a visible sync error when purging actually fails, so eBay retries instead of the failure going unnoticed", async () => {
    deleteOAuthConnectionsByExternalAccountMock.mockRejectedValue(new Error("Secrets Manager: AccessDeniedException"));

    const res = (await handler(
      makeEvent({
        requestContext: { http: { method: "POST" } } as never,
        headers: { "x-ebay-signature": "sig-header" },
        body: JSON.stringify({ metadata: { topic: "MARKETPLACE_ACCOUNT_DELETION" }, notification: { data: { userId: "u-5" } } }),
      }),
    )) as { statusCode: number };

    expect(res.statusCode).not.toBe(204);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(recordSyncErrorMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channel: "ebay",
        errorCode: "ebay_account_deletion_failed",
        errorMessage: "Secrets Manager: AccessDeniedException",
        payload: { userId: "u-5" },
      }),
    );
  });
});
