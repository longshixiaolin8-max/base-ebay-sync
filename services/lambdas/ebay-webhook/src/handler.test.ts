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

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: () => getDbMock(),
  getQueueUrls: () => getQueueUrlsMock(),
  pollChannelSales: (...args: unknown[]) => pollChannelSalesMock(...args),
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
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
});
