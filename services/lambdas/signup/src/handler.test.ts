import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

class UsernameExistsExceptionFake extends Error {}

const cognitoSendMock = vi.fn();
vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({ send: cognitoSendMock })),
  AdminCreateUserCommand: vi.fn((input: unknown) => ({ kind: "AdminCreateUser", input })),
  AdminDeleteUserCommand: vi.fn((input: unknown) => ({ kind: "AdminDeleteUser", input })),
  AdminSetUserPasswordCommand: vi.fn((input: unknown) => ({ kind: "AdminSetUserPassword", input })),
  UsernameExistsException: UsernameExistsExceptionFake,
}));

const claimSignupVerificationMock = vi.fn();
const createPendingTenantMock = vi.fn();
const deletePendingTenantMock = vi.fn();
const deleteSignupVerificationMock = vi.fn();
const getSignupVerificationMock = vi.fn();
const incrementSignupVerificationAttemptMock = vi.fn();
const setPendingTenantStripeCustomerIdMock = vi.fn();
const upsertSignupVerificationMock = vi.fn();
vi.mock("@ai-ec/db", () => ({
  claimSignupVerification: (...args: unknown[]) => claimSignupVerificationMock(...args),
  createPendingTenant: (...args: unknown[]) => createPendingTenantMock(...args),
  deletePendingTenant: (...args: unknown[]) => deletePendingTenantMock(...args),
  deleteSignupVerification: (...args: unknown[]) => deleteSignupVerificationMock(...args),
  getSignupVerification: (...args: unknown[]) => getSignupVerificationMock(...args),
  incrementSignupVerificationAttempt: (...args: unknown[]) => incrementSignupVerificationAttemptMock(...args),
  setPendingTenantStripeCustomerId: (...args: unknown[]) => setPendingTenantStripeCustomerIdMock(...args),
  upsertSignupVerification: (...args: unknown[]) => upsertSignupVerificationMock(...args),
}));

const OTP_PEPPER = "0123456789abcdef0123456789abcdef0123456789abcdef";
const getAppCredentialsMock = vi.fn();
const getDbMock = vi.fn(() => ({ db: true }));
const recordAuditLogMock = vi.fn();
const sendEmailMock = vi.fn();
const requireEnvMock = vi.fn((name: string) => {
  if (name === "COGNITO_USER_POOL_ID") return "pool-1";
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
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
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
  return (await handler(makeEvent(body, method, rawPath))) as {
    statusCode: number;
    body?: string;
    headers?: Record<string, string>;
  };
}

function commandKind(callIndex: number): string {
  return cognitoSendMock.mock.calls[callIndex]?.[0]?.kind;
}

function otpHash(email: string, code: string): string {
  return createHmac("sha256", OTP_PEPPER).update(`${email}:${code}`).digest("hex");
}

function validChallenge(email = "a@example.com", code = "123456") {
  return {
    email,
    codeHash: otpHash(email, code),
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    attempts: 0,
    resendAvailableAt: new Date(Date.now() - 1000),
  };
}

describe("public signup", () => {
  beforeEach(() => {
    process.env.PLATFORM_ENV = "dev";
    cognitoSendMock.mockReset();
    cognitoSendMock.mockResolvedValue({});

    claimSignupVerificationMock.mockReset();
    claimSignupVerificationMock.mockResolvedValue(true);
    createPendingTenantMock.mockReset();
    createPendingTenantMock.mockImplementation(async (_db: unknown, _name: string, options: { id: string }) => ({ id: options.id }));
    deletePendingTenantMock.mockReset();
    deletePendingTenantMock.mockResolvedValue(undefined);
    deleteSignupVerificationMock.mockReset();
    deleteSignupVerificationMock.mockResolvedValue(undefined);
    getSignupVerificationMock.mockReset();
    getSignupVerificationMock.mockResolvedValue(undefined);
    incrementSignupVerificationAttemptMock.mockReset();
    incrementSignupVerificationAttemptMock.mockResolvedValue(undefined);
    setPendingTenantStripeCustomerIdMock.mockReset();
    setPendingTenantStripeCustomerIdMock.mockResolvedValue(undefined);
    upsertSignupVerificationMock.mockReset();
    upsertSignupVerificationMock.mockResolvedValue(undefined);

    recordAuditLogMock.mockReset();
    recordAuditLogMock.mockResolvedValue(undefined);
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue(undefined);

    getAppCredentialsMock.mockReset();
    getAppCredentialsMock.mockImplementation(async (channel: string) => {
      if (channel === "signup-otp") return { otpPepper: OTP_PEPPER };
      if (channel === "stripe") {
        return {
          secretKey: "sk_test_123",
          publishableKey: "pk_test_123",
          priceId: "price_1",
          webhookSigningSecret: "whsec_1",
        };
      }
      throw new Error(`unexpected channel ${channel}`);
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

  it("requires terms and a Cognito-compatible strong password before sending email", async () => {
    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      email: "a@example.com",
      password: "weak",
      acceptedTerms: true,
    });
    expect(res.statusCode).toBe(400);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(cognitoSendMock).not.toHaveBeenCalled();
  });

  it("starts signup by storing only an HMAC challenge and sending SES email", async () => {
    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      name: "Yamada Taro",
      email: "A@Example.com ",
      password: "Password!123",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(200);
    expect(upsertSignupVerificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "a@example.com",
        codeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: expect.any(Date),
        resendAvailableAt: expect.any(Date),
      }),
    );
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "a@example.com",
        subject: expect.stringContaining("確認コード"),
      }),
    );
    expect(cognitoSendMock).not.toHaveBeenCalled();
    expect(createPendingTenantMock).not.toHaveBeenCalled();
    expect(customersCreateMock).not.toHaveBeenCalled();
  });

  it("rate limits verification-code reissue for the same email", async () => {
    getSignupVerificationMock.mockResolvedValueOnce({
      ...validChallenge(),
      resendAvailableAt: new Date(Date.now() + 30_000),
    });

    const res = await callHandler({ action: "resend", email: "a@example.com" });

    expect(res.statusCode).toBe(429);
    expect(res.headers?.["Retry-After"]).toBeTruthy();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("deletes the challenge if SES cannot deliver the verification email", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("SES down"));

    const res = await callHandler({
      action: "start",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(503);
    expect(deleteSignupVerificationMock).toHaveBeenCalledWith(expect.anything(), "a@example.com");
  });

  it("rejects a bad OTP, increments attempts, and creates no customer identity", async () => {
    getSignupVerificationMock.mockResolvedValueOnce(validChallenge("a@example.com", "123456"));

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      confirmationCode: "654321",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(400);
    expect(incrementSignupVerificationAttemptMock).toHaveBeenCalledWith(expect.anything(), "a@example.com");
    expect(cognitoSendMock).not.toHaveBeenCalled();
    expect(createPendingTenantMock).not.toHaveBeenCalled();
  });

  it("atomically consumes a valid OTP before creating Cognito, tenant and Stripe Checkout", async () => {
    getSignupVerificationMock.mockResolvedValueOnce(validChallenge());

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      name: "Yamada Taro",
      email: "a@example.com",
      password: "Password!123",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(200);
    expect(claimSignupVerificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        email: "a@example.com",
        codeHash: otpHash("a@example.com", "123456"),
        maxAttempts: 5,
      }),
    );

    expect(commandKind(0)).toBe("AdminCreateUser");
    expect(commandKind(1)).toBe("AdminSetUserPassword");
    const createInput = cognitoSendMock.mock.calls[0]![0].input;
    const tenantId = createInput.UserAttributes.find((a: { Name: string }) => a.Name === "custom:tenant_id")?.Value;
    expect(tenantId).toBeTruthy();
    expect(createInput).toMatchObject({
      UserPoolId: "pool-1",
      Username: "a@example.com",
      TemporaryPassword: "Password!123",
      MessageAction: "SUPPRESS",
    });
    expect(createInput.UserAttributes).toContainEqual({ Name: "email_verified", Value: "true" });
    expect(createInput.UserAttributes).toContainEqual({ Name: "name", Value: "Yamada Taro" });

    expect(createPendingTenantMock).toHaveBeenCalledWith(
      expect.anything(),
      "Acme",
      { id: tenantId, contactEmail: "a@example.com" },
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId,
        action: "terms_accepted",
        after: { termsVersion: "2026-10-03", privacyVersion: "2026-10-03" },
      }),
    );
    expect(customersCreateMock).toHaveBeenCalledWith({
      email: "a@example.com",
      metadata: { tenantId },
    });
    expect(checkoutSessionsCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_new",
        cancel_url: "https://admin.example/login?signup=pending-payment",
        subscription_data: { trial_period_days: 30 },
      }),
    );
    expect(JSON.parse(res.body!)).toEqual({ checkoutUrl: "https://checkout.stripe.example/session" });
  });

  it("compensates Cognito if tenant/audit persistence fails", async () => {
    getSignupVerificationMock.mockResolvedValueOnce(validChallenge());
    recordAuditLogMock.mockRejectedValueOnce(new Error("audit write failed"));

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(500);
    expect(deletePendingTenantMock).toHaveBeenCalled();
    expect(commandKind(2)).toBe("AdminDeleteUser");
    expect(customersCreateMock).not.toHaveBeenCalled();
  });

  it("returns already_registered when Cognito already owns the email", async () => {
    getSignupVerificationMock.mockResolvedValueOnce(validChallenge());
    cognitoSendMock.mockRejectedValueOnce(new UsernameExistsExceptionFake("exists"));

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(409);
    expect(createPendingTenantMock).not.toHaveBeenCalled();
  });

  it("keeps the verified account recoverable when Stripe Checkout is temporarily unavailable", async () => {
    getSignupVerificationMock.mockResolvedValueOnce(validChallenge());
    checkoutSessionsCreateMock.mockRejectedValueOnce(new Error("Stripe outage"));

    const res = await callHandler({
      action: "confirm",
      companyName: "Acme",
      email: "a@example.com",
      password: "Password!123",
      confirmationCode: "123456",
      acceptedTerms: true,
    });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!)).toEqual({ error: "checkout_unavailable", accountCreated: true });
    expect(deletePendingTenantMock).not.toHaveBeenCalled();
  });

  it("returns the live Stripe price metadata publicly", async () => {
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

  it("blocks production acquisition if Stripe is still test mode", async () => {
    process.env.PLATFORM_ENV = "prod";
    const res = await callHandler(undefined, "GET", "/public/pricing");
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body!)).toEqual({ error: "billing_not_live" });
  });
});
