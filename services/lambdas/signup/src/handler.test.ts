import { beforeEach, describe, expect, it, vi } from "vitest";

class UsernameExistsExceptionFake extends Error {}
class NotAuthorizedExceptionFake extends Error {}

let cognitoUserStatus = "CONFIRMED";
const cognitoSendMock = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({ send: cognitoSendMock })),
  SignUpCommand: vi.fn((input: unknown) => ({ kind: "SignUp", input })),
  ConfirmSignUpCommand: vi.fn((input: unknown) => ({ kind: "ConfirmSignUp", input })),
  ResendConfirmationCodeCommand: vi.fn((input: unknown) => ({ kind: "ResendConfirmationCode", input })),
  AdminGetUserCommand: vi.fn((input: unknown) => ({ kind: "AdminGetUser", input })),
  UsernameExistsException: UsernameExistsExceptionFake,
  NotAuthorizedException: NotAuthorizedExceptionFake,
}));

const createPendingTenantMock = vi.fn();
const deletePendingTenantMock = vi.fn();
const getTenantBillingStatusMock = vi.fn();
const setPendingTenantStripeCustomerIdMock = vi.fn();
vi.mock("@ai-ec/db", () => ({
  createPendingTenant: (...args: unknown[]) => createPendingTenantMock(...args),
  deletePendingTenant: (...args: unknown[]) => deletePendingTenantMock(...args),
  getTenantBillingStatus: (...args: unknown[]) => getTenantBillingStatusMock(...args),
  setPendingTenantStripeCustomerId: (...args: unknown[]) => setPendingTenantStripeCustomerIdMock(...args),
}));

const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn(() => ({ db: true }));
const recordAuditLogMock = vi.fn();
const requireEnvMock = vi.fn((name: string) => {
  if (name === "COGNITO_USER_POOL_ID") return "pool-1";
  if (name === "COGNITO_USER_POOL_CLIENT_ID") return "client-1";
  if (name === "ADMIN_APP_URL") return "https://admin.example";
  throw new Error(`unexpected env var ${name}`);
});
const customersCreateMock = vi.fn();
const checkoutSessionsCreateMock = vi.fn();
const pricesRetrieveMock = vi.fn();
const createStripeClientMock = vi.fn(() => ({
  customers: { create: customersCreateMock },
  checkout: { sessions: { create: checkoutSessionsCreateMock } },
  prices: { retrieve: pricesRetrieveMock },
}));
vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  getDb: () => getDbMock(),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  requireCloudFrontOrigin: () => null,
  requireEnv: (name: string) => requireEnvMock(name),
  createStripeClient: () => createStripeClientMock(),
}));

const { handler } = await import("./handler.js");

function makeEvent(body?: unknown, method = "POST", rawPath = "/signup") {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    rawPath,
    requestContext: { http: { method } },
  } as never;
}

async function callHandler(body?: unknown, method = "POST", rawPath = "/signup") {
  return (await handler(makeEvent(body, method, rawPath))) as { statusCode: number; body?: string };
}

function commandKind(callIndex: number): string {
  return cognitoSendMock.mock.calls[callIndex]?.[0]?.kind;
}

const pendingBilling = {
  plan: "standard",
  status: "pending_payment",
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  name: "Acme",
  gracePeriodEndsAt: null,
  lastBillingEventAt: null,
};

describe("public signup", () => {
  beforeEach(() => {
    process.env.PLATFORM_ENV = "dev";
    cognitoUserStatus = "CONFIRMED";
    cognitoSendMock.mockReset();
    cognitoSendMock.mockImplementation(async (command: { kind: string }) => {
      if (command.kind === "AdminGetUser") {
        return {
          UserStatus: cognitoUserStatus,
          UserAttributes: [{ Name: "custom:tenant_id", Value: "tenant-new" }],
        };
      }
      return {};
    });

    createPendingTenantMock.mockReset();
    createPendingTenantMock.mockResolvedValue({ id: "tenant-new" });
    deletePendingTenantMock.mockReset();
    deletePendingTenantMock.mockResolvedValue(undefined);
    getTenantBillingStatusMock.mockReset();
    setPendingTenantStripeCustomerIdMock.mockReset();
    recordAuditLogMock.mockReset();
    recordAuditLogMock.mockResolvedValue(undefined);

    getAppCredentialsMock.mockReset();
    getAppCredentialsMock.mockResolvedValue({
      secretKey: "sk_test_123",
      publishableKey: "pk_test_123",
      priceId: "price_1",
      webhookSigningSecret: "whsec_1",
    });

    customersCreateMock.mockReset();
    customersCreateMock.mockResolvedValue({ id: "cus_new" });
    checkoutSessionsCreateMock.mockReset();
    checkoutSessionsCreateMock.mockResolvedValue({ url: "https://checkout.stripe.example/session" });
    pricesRetrieveMock.mockReset();
    pricesRetrieveMock.mockResolvedValue({
      unit_amount: 9800,
      currency: "jpy",
      recurring: { interval: "month" },
    });
  });

  it("requires terms acceptance and the account fields", async () => {
    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      acceptedTerms: false,
    });
    expect(res.statusCode).toBe(400);
    expect(cognitoSendMock).not.toHaveBeenCalled();
  });

  it("starts Cognito verification without creating Aurora or Stripe data", async () => {
    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      name: "Yamada Taro",
      email: "A@Example.com ",
      password: "Password!123",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(200);
    expect(commandKind(0)).toBe("SignUp");
    const signUpInput = cognitoSendMock.mock.calls[0]![0].input;
    expect(signUpInput).toMatchObject({
      ClientId: "client-1",
      Username: "a@example.com",
      Password: "Password!123",
    });
    expect(signUpInput.UserAttributes).toContainEqual({ Name: "name", Value: "Yamada Taro" });
    expect(signUpInput.UserAttributes.find((a: { Name: string }) => a.Name === "custom:tenant_id")?.Value).toBeTruthy();
    expect(createPendingTenantMock).not.toHaveBeenCalled();
    expect(customersCreateMock).not.toHaveBeenCalled();
    expect(recordAuditLogMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body!)).toEqual({ confirmationRequired: true, email: "a@example.com" });
  });

  it("recovers an unconfirmed duplicate signup by resending the verification code", async () => {
    cognitoUserStatus = "UNCONFIRMED";
    cognitoSendMock.mockImplementation(async (command: { kind: string }) => {
      if (command.kind === "SignUp") throw new UsernameExistsExceptionFake("exists");
      if (command.kind === "AdminGetUser") {
        return {
          UserStatus: "UNCONFIRMED",
          UserAttributes: [{ Name: "custom:tenant_id", Value: "tenant-new" }],
        };
      }
      return {};
    });

    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(200);
    expect(commandKind(0)).toBe("SignUp");
    expect(commandKind(1)).toBe("AdminGetUser");
    expect(commandKind(2)).toBe("ResendConfirmationCode");
    expect(createPendingTenantMock).not.toHaveBeenCalled();
    expect(JSON.parse(res.body!)).toMatchObject({ confirmationRequired: true, resumed: true });
  });

  it("returns 409 for an already-confirmed account", async () => {
    cognitoSendMock.mockImplementation(async (command: { kind: string }) => {
      if (command.kind === "SignUp") throw new UsernameExistsExceptionFake("exists");
      if (command.kind === "AdminGetUser") {
        return {
          UserStatus: "CONFIRMED",
          UserAttributes: [{ Name: "custom:tenant_id", Value: "tenant-new" }],
        };
      }
      return {};
    });

    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(409);
    expect(createPendingTenantMock).not.toHaveBeenCalled();
  });

  it("creates the tenant only after email confirmation, records consent, then creates Checkout", async () => {
    getTenantBillingStatusMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(pendingBilling);

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(commandKind(0)).toBe("ConfirmSignUp");
    expect(commandKind(1)).toBe("AdminGetUser");
    expect(createPendingTenantMock).toHaveBeenCalledWith(
      expect.anything(),
      "Acme",
      { id: "tenant-new", contactEmail: "a@example.com" },
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant-new",
        action: "terms_accepted",
        after: { termsVersion: "2026-10-03", privacyVersion: "2026-10-03" },
      }),
    );
    expect(customersCreateMock).toHaveBeenCalledWith({
      email: "a@example.com",
      metadata: { tenantId: "tenant-new" },
    });
    expect(setPendingTenantStripeCustomerIdMock).toHaveBeenCalledWith(expect.anything(), "tenant-new", "cus_new");
    expect(checkoutSessionsCreateMock).toHaveBeenCalledWith({
      mode: "subscription",
      customer: "cus_new",
      line_items: [{ price: "price_1", quantity: 1 }],
      success_url: "https://admin.example/login?checkout=success",
      cancel_url: "https://admin.example/signup?checkout=cancelled",
      metadata: { tenantId: "tenant-new" },
      subscription_data: { trial_period_days: 30 },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rolls back an unpaid tenant if consent audit persistence fails", async () => {
    getTenantBillingStatusMock.mockResolvedValueOnce(undefined);
    recordAuditLogMock.mockRejectedValueOnce(new Error("audit db error"));

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(500);
    expect(deletePendingTenantMock).toHaveBeenCalledWith(expect.anything(), "tenant-new");
    expect(customersCreateMock).not.toHaveBeenCalled();
  });

  it("can recreate Checkout after confirmation already happened", async () => {
    cognitoSendMock.mockImplementation(async (command: { kind: string }) => {
      if (command.kind === "ConfirmSignUp") throw new NotAuthorizedExceptionFake("already confirmed");
      if (command.kind === "AdminGetUser") {
        return {
          UserStatus: "CONFIRMED",
          UserAttributes: [{ Name: "custom:tenant_id", Value: "tenant-new" }],
        };
      }
      return {};
    });
    getTenantBillingStatusMock.mockResolvedValue({
      ...pendingBilling,
      stripeCustomerId: "cus_existing",
    });

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(200);
    expect(createPendingTenantMock).not.toHaveBeenCalled();
    expect(customersCreateMock).not.toHaveBeenCalled();
    expect(checkoutSessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_existing" }),
    );
  });

  it("supports resending the Cognito verification code", async () => {
    const res = await callHandler({ action: "resend", email: "a@example.com" });
    expect(res.statusCode).toBe(200);
    expect(commandKind(0)).toBe("ResendConfirmationCode");
  });

  it("returns real Stripe price metadata publicly", async () => {
    const res = await callHandler(undefined, "GET", "/public/pricing");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      unitAmount: 9800,
      currency: "jpy",
      interval: "month",
      trialDays: 30,
      live: false,
    });
  });

  it("blocks production signup/pricing when Stripe is still test mode", async () => {
    process.env.PLATFORM_ENV = "prod";
    const res = await callHandler(undefined, "GET", "/public/pricing");
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!)).toEqual({ error: "billing_not_live" });
  });
});
