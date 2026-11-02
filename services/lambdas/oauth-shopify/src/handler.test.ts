import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn().mockReturnValue({} as never);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const saveOAuthTokenMock = vi.fn().mockResolvedValue(undefined);
const verifyStateMock = vi.fn().mockReturnValue("tenant-a");
const exchangeCodeForTokenMock = vi.fn();
const createShopifyAdapterMock = vi.fn().mockReturnValue({
  exchangeCodeForToken: exchangeCodeForTokenMock,
});

vi.mock("@ai-ec/lambda-shared", () => ({
  createShopifyAdapter: (...args: unknown[]) => createShopifyAdapterMock(...args),
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: (...args: unknown[]) => getDbMock(...args),
  normalizeShopDomain: (raw: string) => {
    const stripped = raw.trim().toLowerCase().replace(/\.myshopify\.com$/, "");
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(stripped)) throw new Error(`Invalid Shopify shop domain: ${raw}`);
    return stripped;
  },
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  requireCloudFrontOrigin: () => null,
  requireEnv: () => "https://api.example/oauth/shopify/callback",
  saveOAuthToken: (...args: unknown[]) => saveOAuthTokenMock(...args),
  verifyState: (...args: unknown[]) => verifyStateMock(...args),
}));

const handlerModule = await import("./handler.js");
const { callback } = handlerModule;

function makeEvent(query: Record<string, string>): APIGatewayProxyEventV2 {
  return { queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

describe("oauth-shopify callback", () => {
  beforeEach(() => {
    getAppCredentialsMock.mockReset().mockResolvedValue({ clientId: "cid", clientSecret: "secret" });
    exchangeCodeForTokenMock
      .mockReset()
      .mockResolvedValue({ accessToken: "shpat_x", refreshToken: null, expiresAt: new Date(), scope: "read_products" });
    createShopifyAdapterMock.mockClear().mockReturnValue({ exchangeCodeForToken: exchangeCodeForTokenMock });
    saveOAuthTokenMock.mockClear();
    recordAuditLogMock.mockClear();
    verifyStateMock.mockReset().mockReturnValue("tenant-a");
  });

  it("returns 400 when code, state or shop is missing", async () => {
    const res = (await callback(makeEvent({ code: "abc", state: "s" }))) as { statusCode: number };
    expect(res).toEqual({ statusCode: 400, body: "Missing code, state or shop" });
    expect(saveOAuthTokenMock).not.toHaveBeenCalled();
  });

  it("rejects oversized query parameters before contacting third parties", async () => {
    const response = (await callback(
      makeEvent({ code: "x".repeat(2049), state: "a", shop: "my-store" }),
    )) as { statusCode: number };
    expect(response.statusCode).toBe(400);
    expect(getAppCredentialsMock).not.toHaveBeenCalled();
  });

  it("rejects a shop value that doesn't look like a real Shopify subdomain, before ever building a fetch URL from it", async () => {
    const res = (await callback(
      makeEvent({ code: "abc", state: "s", shop: "evil.com/.well-known" }),
    )) as { statusCode: number; body?: string };
    expect(res.statusCode).toBe(400);
    expect(res.body).toBe("Invalid shop domain");
    expect(getAppCredentialsMock).not.toHaveBeenCalled();
  });

  it("never echoes state errors or provider errors into public responses", async () => {
    const marker = "SENSITIVE_CANARY_MUST_NOT_BE_LOGGED";
    verifyStateMock.mockImplementationOnce(() => {
      throw new Error(marker);
    });
    const stateResponse = (await callback(
      makeEvent({ code: "abc", state: "bad", shop: "my-store" }),
    )) as { statusCode: number; body?: string };
    expect(stateResponse.statusCode).toBe(400);
    expect(stateResponse.body).not.toContain(marker);
    expect(exchangeCodeForTokenMock).not.toHaveBeenCalled();

    exchangeCodeForTokenMock.mockRejectedValueOnce(new Error(marker));
    const providerResponse = (await callback(
      makeEvent({ code: "abc", state: "signed-state", shop: "my-store" }),
    )) as { statusCode: number; body?: string };
    expect(providerResponse.statusCode).toBe(502);
    expect(providerResponse.body).not.toContain(marker);
  });

  it("normalizes a full myshopify.com host down to the bare subdomain and uses it directly as externalAccountId -- no extra identity call needed", async () => {
    const res = (await callback(
      makeEvent({ code: "abc", state: "signed-state", shop: "my-store.myshopify.com" }),
    )) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(createShopifyAdapterMock).toHaveBeenCalledWith(expect.anything(), "my-store");
    expect(saveOAuthTokenMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "shopify", "my-store", expect.anything());
  });

  it("never lets two different tenants collide on the same externalAccountId", async () => {
    verifyStateMock.mockReturnValueOnce("tenant-a").mockReturnValueOnce("tenant-b");

    await callback(makeEvent({ code: "abc", state: "state-a", shop: "store-a" }));
    await callback(makeEvent({ code: "abc", state: "state-b", shop: "store-b" }));

    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(1, expect.anything(), "tenant-a", "shopify", "store-a", expect.anything());
    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(2, expect.anything(), "tenant-b", "shopify", "store-b", expect.anything());
  });
});
