import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn().mockReturnValue({} as never);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const saveOAuthTokenMock = vi.fn().mockResolvedValue(undefined);
const verifyStateMock = vi.fn().mockReturnValue("tenant-a");
const exchangeCodeForTokenMock = vi.fn();
const getAuthenticatedUserIdMock = vi.fn();
const createEbayAdapterMock = vi.fn().mockReturnValue({
  exchangeCodeForToken: exchangeCodeForTokenMock,
  getAuthenticatedUserId: getAuthenticatedUserIdMock,
});

vi.mock("@ai-ec/lambda-shared", () => ({
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: (...args: unknown[]) => getDbMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  requireCloudFrontOrigin: () => null,
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

describe("oauth-ebay callback", () => {
  beforeEach(() => {
    getAppCredentialsMock.mockReset().mockResolvedValue({ clientId: "cid", clientSecret: "secret", ruName: "ru" });
    exchangeCodeForTokenMock
      .mockReset()
      .mockResolvedValue({ accessToken: "at", refreshToken: "rt", expiresAt: new Date(), scope: null });
    getAuthenticatedUserIdMock.mockReset();
    saveOAuthTokenMock.mockClear();
    recordAuditLogMock.mockClear();
    verifyStateMock.mockReset().mockReturnValue("tenant-a");
  });

  it("returns 400 when code or state is missing", async () => {
    const res = (await callback(makeEvent({}))) as { statusCode: number };
    expect(res).toEqual({ statusCode: 400, body: "Missing code or state" });
    expect(saveOAuthTokenMock).not.toHaveBeenCalled();
  });

  it("uses eBay's real immutable userId as externalAccountId -- never the literal string 'default'", async () => {
    getAuthenticatedUserIdMock.mockResolvedValue("007REALuserId");

    const res = (await callback(makeEvent({ code: "abc", state: "signed-state" }))) as { statusCode: number };

    expect(res.statusCode).toBe(200);
    expect(saveOAuthTokenMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-a",
      "ebay",
      "007REALuserId",
      expect.anything(),
    );
  });

  it("does not record any oauth connection when the identity lookup fails (e.g. missing scope)", async () => {
    getAuthenticatedUserIdMock.mockRejectedValue(new Error("eBay API error 403: insufficient_scope"));

    const res = (await callback(makeEvent({ code: "abc", state: "signed-state" }))) as { statusCode: number };

    expect(res.statusCode).toBe(502);
    expect(saveOAuthTokenMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("never lets two different tenants collide on the same externalAccountId", async () => {
    getAuthenticatedUserIdMock.mockResolvedValueOnce("userA").mockResolvedValueOnce("userB");
    verifyStateMock.mockReturnValueOnce("tenant-a").mockReturnValueOnce("tenant-b");

    await callback(makeEvent({ code: "abc", state: "state-a" }));
    await callback(makeEvent({ code: "abc", state: "state-b" }));

    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(1, expect.anything(), "tenant-a", "ebay", "userA", expect.anything());
    expect(saveOAuthTokenMock).toHaveBeenNthCalledWith(2, expect.anything(), "tenant-b", "ebay", "userB", expect.anything());
  });
});
