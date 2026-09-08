import { beforeEach, describe, expect, it, vi } from "vitest";

class UsernameExistsExceptionFake extends Error {}

const cognitoSendMock = vi.fn().mockResolvedValue({});
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({ send: cognitoSendMock })),
  AdminCreateUserCommand: vi.fn((input: unknown) => ({ input })),
  AdminSetUserPasswordCommand: vi.fn((input: unknown) => ({ input })),
  UsernameExistsException: UsernameExistsExceptionFake,
}));

const createPendingTenantMock = vi.fn().mockResolvedValue({ id: "tenant-new" });
vi.mock("@ai-ec/db", () => ({
  createPendingTenant: (...args: unknown[]) => createPendingTenantMock(...args),
}));

const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn(() => ({}));
const requireEnvMock = vi.fn((name: string) => {
  if (name === "COGNITO_USER_POOL_ID") return "pool-1";
  if (name === "ADMIN_APP_URL") return "https://admin.example";
  throw new Error(`unexpected env var ${name}`);
});
const customersCreateMock = vi.fn().mockResolvedValue({ id: "cus_new" });
const checkoutSessionsCreateMock = vi.fn().mockResolvedValue({ url: "https://checkout.stripe.example/session" });
const createStripeClientMock = vi.fn(() => ({
  customers: { create: customersCreateMock },
  checkout: { sessions: { create: checkoutSessionsCreateMock } },
}));
vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: () => getDbMock(),
  requireEnv: (name: string) => requireEnvMock(name),
  createStripeClient: () => createStripeClientMock(),
}));

const { handler } = await import("./handler.js");

function makeEvent(body: unknown) {
  return { body: JSON.stringify(body) } as never;
}

/** The handler always returns the {statusCode, body} shape; narrow away the union for tests. */
async function callHandler(body: unknown) {
  return (await handler(makeEvent(body))) as { statusCode: number; body?: string };
}

describe("POST /signup", () => {
  beforeEach(() => {
    cognitoSendMock.mockClear();
    cognitoSendMock.mockResolvedValue({});
    createPendingTenantMock.mockClear();
    createPendingTenantMock.mockResolvedValue({ id: "tenant-new" });
    getAppCredentialsMock.mockReset();
    getAppCredentialsMock.mockImplementation(async (channel: string) => {
      if (channel === "signup") return { inviteCode: "beta-2026" };
      if (channel === "stripe") return { secretKey: "sk_test", publishableKey: "pk_test", priceId: "price_1", webhookSigningSecret: "whsec_1" };
      throw new Error(`unexpected channel ${channel}`);
    });
    customersCreateMock.mockClear();
    customersCreateMock.mockResolvedValue({ id: "cus_new" });
    checkoutSessionsCreateMock.mockClear();
    checkoutSessionsCreateMock.mockResolvedValue({ url: "https://checkout.stripe.example/session" });
  });

  it("rejects a request missing required fields", async () => {
    const res = await callHandler({ email: "a@example.com" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid invite code without touching Cognito or Stripe", async () => {
    const res = await callHandler({ companyName: "Acme", email: "a@example.com", password: "hunter2hunter2", inviteCode: "wrong" });
    expect(res.statusCode).toBe(403);
    expect(cognitoSendMock).not.toHaveBeenCalled();
    expect(createPendingTenantMock).not.toHaveBeenCalled();
  });

  it("creates a pending tenant, a Cognito user with the tenant claim, and a Stripe checkout session", async () => {
    const res = await callHandler({
      companyName: "Acme",
      email: "a@example.com",
      password: "hunter2hunter2",
      inviteCode: "beta-2026",
    });

    expect(createPendingTenantMock).toHaveBeenCalledWith(expect.anything(), "Acme");

    const [createUserCall, setPasswordCall] = cognitoSendMock.mock.calls;
    expect(createUserCall![0].input).toMatchObject({
      UserPoolId: "pool-1",
      Username: "a@example.com",
      TemporaryPassword: "hunter2hunter2",
      MessageAction: "SUPPRESS",
    });
    expect(createUserCall![0].input.UserAttributes).toContainEqual({ Name: "custom:tenant_id", Value: "tenant-new" });
    expect(setPasswordCall![0].input).toMatchObject({
      UserPoolId: "pool-1",
      Username: "a@example.com",
      Password: "hunter2hunter2",
      Permanent: true,
    });

    expect(customersCreateMock).toHaveBeenCalledWith({ email: "a@example.com", metadata: { tenantId: "tenant-new" } });
    expect(checkoutSessionsCreateMock).toHaveBeenCalledWith({
      mode: "subscription",
      customer: "cus_new",
      line_items: [{ price: "price_1", quantity: 1 }],
      success_url: "https://admin.example/login?checkout=success",
      cancel_url: "https://admin.example/signup",
      metadata: { tenantId: "tenant-new" },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ checkoutUrl: "https://checkout.stripe.example/session" });
  });

  it("sets the Cognito name attribute when a name is provided, and omits it when not", async () => {
    await callHandler({
      companyName: "Acme",
      name: "Yamada Taro",
      email: "a@example.com",
      password: "hunter2hunter2",
      inviteCode: "beta-2026",
    });
    const [createUserCall] = cognitoSendMock.mock.calls;
    expect(createUserCall![0].input.UserAttributes).toContainEqual({ Name: "name", Value: "Yamada Taro" });

    cognitoSendMock.mockClear();
    await callHandler({
      companyName: "Acme",
      email: "b@example.com",
      password: "hunter2hunter2",
      inviteCode: "beta-2026",
    });
    const [createUserCallNoName] = cognitoSendMock.mock.calls;
    const attrNames = (createUserCallNoName![0].input.UserAttributes as Array<{ Name: string }>).map((a) => a.Name);
    expect(attrNames).not.toContain("name");
  });

  it("returns 409 without touching Stripe when the email is already registered", async () => {
    cognitoSendMock.mockRejectedValueOnce(new UsernameExistsExceptionFake("exists"));

    const res = await callHandler({
      companyName: "Acme",
      email: "a@example.com",
      password: "hunter2hunter2",
      inviteCode: "beta-2026",
    });

    expect(res.statusCode).toBe(409);
    expect(customersCreateMock).not.toHaveBeenCalled();
  });
});
