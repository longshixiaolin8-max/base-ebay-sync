import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const exchangeCodeForTokenMock = vi.fn();
const getAuthenticatedShopIdMock = vi.fn();
const getAuthorizationUrlMock = vi.fn().mockReturnValue("https://api.thebase.in/1/oauth/authorize?...");
const BaseAdapterMock = vi.fn().mockImplementation(() => ({
  exchangeCodeForToken: exchangeCodeForTokenMock,
  getAuthenticatedShopId: getAuthenticatedShopIdMock,
  getAuthorizationUrl: getAuthorizationUrlMock,
}));

vi.mock("@ai-ec/adapter-base", () => ({
  BaseAdapter: BaseAdapterMock,
}));

const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn().mockReturnValue({} as never);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const saveOAuthTokenMock = vi.fn().mockResolvedValue(undefined);
const verifyStateMock = vi.fn().mockReturnValue("tenant-a");
const requireEnvMock = vi.fn().mockReturnValue("https://api.example/oauth/base/callback");

vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: (...args: unknown[]) => getDbMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  requireEnv: (...args: unknown[]) => requireEnvMock(...args),
  saveOAuthToken: (...args: unknown[]) => saveOAuthTokenMock(...args),
  verifyState: (...args: unknown[]) => verifyStateMock(...args),
}));

const handlerModule = await import("./handler.js");
const { callback } = handlerModule;

it("no longer exports a public authorize() handler (round 12: public OAuth authorize routeを廃止)", () => {
  expect("authorize" in handlerModule).toBe(false);
});

function makeEvent(query: Record<string, string>): APIGatewayProxyEventV2 {
  return { queryStringParameters: query } as unknown as APIGatewayProxyEventV2;
}

describe("oauth-base callback", () => {
  beforeEach(() => {
    getAppCredentialsMock.mockReset().mockResolvedValue({ clientId: "cid", clientSecret: "secret" });
    exchangeCodeForTokenMock
      .mockReset()
      .mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: new Date(), scope: null });
    getAuthenticatedShopIdMock.mockReset();
    saveOAuthTokenMock.mockClear();
    recordAuditLogMock.mockClear();
    verifyStateMock.mockReset().mockReturnValue("tenant-a");
  });

  it("returns 400 when code or state is missing", async () => {
    const res = (await callback(makeEvent({}))) as { statusCode: number };
    expect(res).toEqual({ statusCode: 400, body: "Missing code or state" });
    expect(saveOAuthTokenMock).not.toHaveBeenCalled();
  });

  it("uses BASE's real shop_id as externalAccountId -- never the literal string 'default'", async () => {
    getAuthenticatedShopIdMock.mockResolvedValue("my-real-shop");

    const res = (await callback(makeEvent({ code: "abc", state: "signed-state" }))) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(saveOAuthTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-a",
      "base",
      "my-real-shop",
      expect.anything(),
    );
  });

  it("does not record any oauth connection when the shop-id lookup fails", async () => {
    getAuthenticatedShopIdMock.mockRejectedValue(new Error("BASE API error 401: unauthorized"));

    const res = (await callback(makeEvent({ code: "abc", state: "signed-state" }))) as { statusCode: number };

    expect(res.statusCode).toBe(502);
    expect(saveOAuthTokenMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("never lets two different tenants collide on the same externalAccountId", async () => {
    getAuthenticatedShopIdMock.mockResolvedValueOnce("shopA").mockResolvedValueOnce("shopB");
    verifyStateMock.mockReturnValueOnce("tenant-a").mockReturnValueOnce("tenant-b");

    await callback(makeEvent({ code: "abc", state: "state-a" }));
    await callback(makeEvent({ code: "abc", state: "state-b" }));

    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(1, expect.anything(), "tenant-a", "base", "shopA", expect.anything());
    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(2, expect.anything(), "tenant-b", "base", "shopB", expect.anything());
  });
});
