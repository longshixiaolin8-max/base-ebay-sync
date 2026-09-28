import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppCredentialsMock = vi.fn();
const pollChannelSalesMock = vi.fn().mockResolvedValue(undefined);
const getDbMock = vi.fn(() => ({}));
const getQueueUrlsMock = vi.fn(() => ({ inventorySync: "inventory-sync-url", ebayPlatformNotificationPoll: "poll-queue-url" }));
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
const enqueueMock = vi.fn().mockResolvedValue(undefined);
const tryClaimMock = vi.fn().mockResolvedValue(null); // null = fresh claim won, matches IdempotencyStore's own convention
const getIdempotencyStoreMock = vi.fn((_tenantId: string) => ({ tryClaim: tryClaimMock, complete: vi.fn(), fail: vi.fn() }));
const verifyWebhookDestinationTokenMock = vi.fn();

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: () => getDbMock(),
  getQueueUrls: () => getQueueUrlsMock(),
  getIdempotencyStore: (tenantId: string) => getIdempotencyStoreMock(tenantId),
  pollChannelSales: (...args: unknown[]) => pollChannelSalesMock(...args),
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
  deleteOAuthConnectionsByExternalAccount: (...args: unknown[]) => deleteOAuthConnectionsByExternalAccountMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  recordSyncError: (...args: unknown[]) => recordSyncErrorMock(...args),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  verifyWebhookDestinationToken: (...args: unknown[]) => verifyWebhookDestinationTokenMock(...args),
}));

const computeChallengeResponseMock = vi.fn((..._args: unknown[]) => "computed-hash");
const parseSignatureHeaderMock = vi.fn();
const verifyNotificationSignatureMock = vi.fn();

vi.mock("@ai-ec/adapter-ebay", () => ({
  computeChallengeResponse: (...args: unknown[]) => computeChallengeResponseMock(...args),
  parseSignatureHeader: (...args: unknown[]) => parseSignatureHeaderMock(...args),
  verifyNotificationSignature: (...args: unknown[]) => verifyNotificationSignatureMock(...args),
}));

const { handler, dispatchPoll } = await import("./handler.js");

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
    getAppCredentialsMock.mockResolvedValue({ webhookVerificationToken: "verify-me", clientSecret: "app-client-secret" });
    process.env.EBAY_WEBHOOK_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/notifications";
    deleteOAuthConnectionsByExternalAccountMock.mockResolvedValue([]);
    parseSignatureHeaderMock.mockReturnValue({ kid: "key-1" });
    getNotificationPublicKeyMock.mockResolvedValue({ algorithm: "ECDSA", digest: "SHA1", key: "pk" });
    verifyNotificationSignatureMock.mockReturnValue(true);
    tryClaimMock.mockResolvedValue(null); // fresh claim by default -- most tests want the poll to actually dispatch
    verifyWebhookDestinationTokenMock.mockReturnValue("tenant-x");
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

  it("POST with a valid signature debounces/dispatches a coalesced poll (via SQS, not a direct call) and returns 204", async () => {
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
    // The actual eBay poll no longer happens inline on this request -- only
    // dispatchPoll (a separate Lambda, tested below) ever calls pollChannelSales.
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalledWith("poll-queue-url", { tenantId: expect.any(String), channel: "ebay" });
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

  it("POST to the platform-notifications path with a valid per-tenant token dispatches a coalesced poll for that tenant and returns 200, regardless of body", async () => {
    verifyWebhookDestinationTokenMock.mockReturnValue("tenant-real");

    const res = (await handler(
      makeEvent({
        rawPath: "/webhooks/ebay/platform-notifications/signed-token-abc",
        pathParameters: { token: "signed-token-abc" },
        requestContext: { http: { method: "POST" } } as never,
        headers: {},
        body: "<FixedPriceTransaction>...</FixedPriceTransaction>",
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(verifyWebhookDestinationTokenMock).toHaveBeenCalledWith("app-client-secret", "signed-token-abc");
    // 正規notificationは迅速にsale pollを起動: the poll is dispatched (enqueued) immediately,
    // not deferred by anything besides the debounce claim itself.
    expect(enqueueMock).toHaveBeenCalledWith("poll-queue-url", { tenantId: "tenant-real", channel: "ebay" });
    // 偽bodyからinventoryを直接変更しない: the body is never even read for this path -- a
    // forged/garbage body changes nothing about what happens (still just enqueues a poll
    // request; pollChannelSales, the only thing that can ever touch inventory, is not
    // called on this request at all).
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
  });

  it("returns 403 and never dispatches a poll when the platform-notifications token is invalid/forged", async () => {
    verifyWebhookDestinationTokenMock.mockImplementation(() => {
      throw new Error("Webhook destination token signature mismatch (possible forged/tampered URL)");
    });

    const res = (await handler(
      makeEvent({
        rawPath: "/webhooks/ebay/platform-notifications/tampered-token",
        pathParameters: { token: "tampered-token" },
        requestContext: { http: { method: "POST" } } as never,
        headers: {},
        body: "<FixedPriceTransaction>...</FixedPriceTransaction>",
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(403);
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(pollChannelSalesMock).not.toHaveBeenCalled();
  });

  it("returns 404 for the platform-notifications path with no token segment at all", async () => {
    const res = (await handler(
      makeEvent({
        rawPath: "/webhooks/ebay/platform-notifications/",
        pathParameters: {},
        requestContext: { http: { method: "POST" } } as never,
        headers: {},
        body: "",
      }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("大量notificationが来てもpollがcoalesceされる: a burst of notifications for the same tenant only enqueues one poll", async () => {
    verifyWebhookDestinationTokenMock.mockReturnValue("tenant-burst");
    // First request wins the debounce claim (tryClaim -> null); every subsequent one within
    // the window finds an existing, still-live claim and is simply dropped.
    tryClaimMock.mockResolvedValueOnce(null).mockResolvedValue({ key: "k", status: "in_progress", result: null });

    const event = makeEvent({
      rawPath: "/webhooks/ebay/platform-notifications/tok",
      pathParameters: { token: "tok" },
      requestContext: { http: { method: "POST" } } as never,
      headers: {},
      body: "<FixedPriceTransaction>...</FixedPriceTransaction>",
    });

    const responses = await Promise.all(Array.from({ length: 20 }, () => handler(event)));

    // Every one of the 20 requests still gets acked promptly -- coalescing debounces the
    // *poll*, never the HTTP response eBay is waiting on.
    for (const res of responses) {
      expect((res as { statusCode: number }).statusCode).toBe(200);
    }
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(pollChannelSalesMock).not.toHaveBeenCalled(); // still never called inline, regardless of volume
  });

  describe("dispatchPoll (the SQS consumer that actually calls pollChannelSales)", () => {
    function sqsEvent(bodies: unknown[]) {
      return {
        Records: bodies.map((body, i) => ({ messageId: `msg-${i}`, body: JSON.stringify(body) })),
      } as never;
    }

    it("polls exactly the tenant/channel named in the message", async () => {
      const result = await dispatchPoll(sqsEvent([{ tenantId: "tenant-a", channel: "ebay" }]), {} as never, {} as never);

      expect(pollChannelSalesMock).toHaveBeenCalledTimes(1);
      const [tenantIdArg] = pollChannelSalesMock.mock.calls[0]!;
      expect(tenantIdArg).toBe("tenant-a");
      expect(result).toEqual({ batchItemFailures: [] });
    });

    it("processes every message in the batch independently -- one failure doesn't block the rest", async () => {
      pollChannelSalesMock.mockRejectedValueOnce(new Error("eBay API 500")).mockResolvedValueOnce(undefined);

      const result = await dispatchPoll(
        sqsEvent([{ tenantId: "tenant-fail", channel: "ebay" }, { tenantId: "tenant-ok", channel: "ebay" }]),
        {} as never,
        {} as never,
      );

      expect(pollChannelSalesMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "msg-0" }] });
    });
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
