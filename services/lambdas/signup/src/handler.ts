import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  claimSignupVerification,
  createPendingTenant,
  deleteExpiredSignupVerifications,
  deletePendingTenant,
  deleteSignupVerification,
  getSignupVerification,
  incrementSignupVerificationAttempt,
  setPendingTenantStripeCustomerId,
  upsertSignupVerification,
} from "@ai-ec/db";
import {
  createStripeClient,
  getAppCredentials,
  getDb,
  recordAuditLog,
  requireCloudFrontOrigin,
  requireEnv,
  sendEmail,
  type StripeAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

interface SignupCredentials {
  otpPepper?: string;
}

interface SignupRequestBody {
  action?: "start" | "confirm" | "resend";
  companyName?: string;
  name?: string;
  email?: string;
  password?: string;
  confirmationCode?: string;
  acceptedTerms?: boolean;
}

type JsonResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

function json(
  statusCode: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): JsonResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

const cognitoClient = new CognitoIdentityProviderClient({});
const FREE_TRIAL_DAYS = 30;
const TERMS_VERSION = "2026-10-03";
const PRIVACY_VERSION = "2026-10-03";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const PUBLIC_PRICING_CACHE_MS = 5 * 60 * 1000;

let pricingCache:
  | {
      key: string;
      expiresAt: number;
      value: {
        unitAmount: number;
        currency: string;
        interval: string;
        trialDays: number;
        live: boolean;
      };
    }
  | undefined;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertLiveBillingInProd(creds: StripeAppCredentials): JsonResult | null {
  if (process.env.PLATFORM_ENV === "prod" && !creds.secretKey.startsWith("sk_live_")) {
    console.error("signup: production signup blocked because Stripe is not using a live secret key");
    return json(503, { error: "billing_not_live" });
  }
  return null;
}

function validSignupPassword(password: string): boolean {
  return (
    password.length >= 12 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /[0-9]/.test(password) &&
    /[^A-Za-z0-9]/.test(password)
  );
}

async function otpPepper(): Promise<string> {
  const creds = await getAppCredentials<SignupCredentials>("signup-otp");
  if (!creds.otpPepper || creds.otpPepper.length < 24) {
    throw new Error("signup otpPepper is not configured");
  }
  return creds.otpPepper;
}

function hashOtp(email: string, code: string, pepper: string): string {
  return createHmac("sha256", pepper).update(`${email}:${code}`).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  try {
    const a = Buffer.from(left, "hex");
    const b = Buffer.from(right, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function issueVerificationCode(email: string): Promise<JsonResult> {
  const db = getDb();
  const now = new Date();
  await deleteExpiredSignupVerifications(db, now);
  const existing = await getSignupVerification(db, email);
  if (existing && existing.resendAvailableAt.getTime() > now.getTime()) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((existing.resendAvailableAt.getTime() - now.getTime()) / 1000),
    );
    return json(
      429,
      { error: "verification_rate_limited", retryAfterSeconds },
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  const code = String(randomInt(100000, 1_000_000));
  const pepper = await otpPepper();
  await upsertSignupVerification(db, {
    email,
    codeHash: hashOtp(email, code, pepper),
    expiresAt: new Date(now.getTime() + OTP_TTL_MS),
    resendAvailableAt: new Date(now.getTime() + OTP_RESEND_COOLDOWN_MS),
  });

  try {
    await sendEmail({
      to: email,
      subject: "BASE eBay Sync メール確認コード",
      bodyText: [
        "BASE eBay Sync の新規登録確認コードです。",
        "",
        `確認コード: ${code}`,
        "",
        "このコードは10分間有効です。",
        "心当たりがない場合は、このメールを無視してください。",
      ].join("\n"),
    });
  } catch (err) {
    await deleteSignupVerification(db, email).catch(() => {});
    console.error("signup: SES verification email failed", (err as Error).message);
    return json(503, { error: "verification_email_unavailable" });
  }

  return json(200, { confirmationRequired: true, email });
}

async function startSignup(body: SignupRequestBody): Promise<JsonResult> {
  const companyName = body.companyName?.trim();
  const email = body.email ? normalizeEmail(body.email) : "";
  const password = body.password ?? "";

  if (!companyName || !email || !validSignupPassword(password) || body.acceptedTerms !== true) {
    return json(400, { error: "missing_fields_or_terms" });
  }

  // No tenant, Cognito identity, Stripe Customer, or password is persisted before email
  // ownership is proven. This keeps arbitrary anonymous traffic out of all durable
  // commercial/customer stores.
  return issueVerificationCode(email);
}

async function resendConfirmation(body: SignupRequestBody): Promise<JsonResult> {
  const email = body.email ? normalizeEmail(body.email) : "";
  if (!email) return json(400, { error: "email_required" });
  const response = await issueVerificationCode(email);
  if (response.statusCode === 200) {
    return json(200, { resent: true, email });
  }
  return response;
}

async function confirmSignup(body: SignupRequestBody): Promise<JsonResult> {
  const companyName = body.companyName?.trim();
  const name = body.name?.trim();
  const email = body.email ? normalizeEmail(body.email) : "";
  const password = body.password ?? "";
  const code = body.confirmationCode?.trim() ?? "";

  if (
    !companyName ||
    !email ||
    !/^\d{6}$/.test(code) ||
    !validSignupPassword(password) ||
    body.acceptedTerms !== true
  ) {
    return json(400, { error: "confirmation_required" });
  }

  const db = getDb();
  const verification = await getSignupVerification(db, email);
  if (!verification) return json(400, { error: "confirmation_invalid_or_expired" });

  const now = new Date();
  if (verification.expiresAt.getTime() <= now.getTime()) {
    await deleteSignupVerification(db, email);
    return json(400, { error: "confirmation_invalid_or_expired" });
  }
  if (verification.attempts >= OTP_MAX_ATTEMPTS) {
    return json(429, { error: "confirmation_locked" });
  }

  const expectedHash = hashOtp(email, code, await otpPepper());
  if (!hashesEqual(expectedHash, verification.codeHash)) {
    await incrementSignupVerificationAttempt(db, email);
    const remainingAttempts = Math.max(0, OTP_MAX_ATTEMPTS - verification.attempts - 1);
    return json(400, { error: "confirmation_invalid_or_expired", remainingAttempts });
  }

  const claimed = await claimSignupVerification(db, {
    email,
    codeHash: expectedHash,
    now,
    maxAttempts: OTP_MAX_ATTEMPTS,
  });
  if (!claimed) return json(409, { error: "confirmation_already_used" });

  const tenantId = randomUUID();
  const userPoolId = requireEnv("COGNITO_USER_POOL_ID");
  let cognitoUserCreated = false;

  try {
    await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          // This flag is safe here because the address was just verified by our own SES OTP.
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenant_id", Value: tenantId },
          ...(name ? [{ Name: "name", Value: name }] : []),
        ],
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
      }),
    );
    cognitoUserCreated = true;
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: userPoolId,
        Username: email,
        Password: password,
        Permanent: true,
      }),
    );
  } catch (err) {
    if (cognitoUserCreated) {
      await cognitoClient
        .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
        .catch(() => {});
    }
    if (err instanceof UsernameExistsException) {
      return json(409, { error: "already_registered" });
    }
    throw err;
  }

  try {
    await createPendingTenant(db, companyName, { id: tenantId, contactEmail: email });
    await recordAuditLog(db, {
      tenantId,
      actor: `signup:${email}`,
      action: "terms_accepted",
      entityType: "tenant",
      entityId: tenantId,
      after: { termsVersion: TERMS_VERSION, privacyVersion: PRIVACY_VERSION },
    });
  } catch (err) {
    await deletePendingTenant(db, tenantId).catch(() => {});
    await cognitoClient
      .send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }))
      .catch(() => {});
    throw err;
  }

  const stripeCreds = await getAppCredentials<StripeAppCredentials>("stripe");
  const liveBillingError = assertLiveBillingInProd(stripeCreds);
  if (liveBillingError) {
    return json(503, { error: "billing_not_live", accountCreated: true });
  }

  try {
    const stripe = createStripeClient(stripeCreds);
    const customer = await stripe.customers.create({ email, metadata: { tenantId } });
    await setPendingTenantStripeCustomerId(db, tenantId, customer.id);

    const adminAppUrl = requireEnv("ADMIN_APP_URL");
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customer.id,
      line_items: [{ price: stripeCreds.priceId, quantity: 1 }],
      success_url: `${adminAppUrl}/login?checkout=success`,
      cancel_url: `${adminAppUrl}/login?signup=pending-payment`,
      metadata: { tenantId },
      subscription_data: { trial_period_days: FREE_TRIAL_DAYS },
    });

    return json(200, { checkoutUrl: session.url });
  } catch (err) {
    // The verified account remains intentionally usable so the operator can sign in and
    // resume payment setup through POST /admin/billing/checkout-session.
    console.error("signup: Stripe checkout creation failed after account creation", (err as Error).message);
    return json(503, { error: "checkout_unavailable", accountCreated: true });
  }
}

async function publicPricing(): Promise<JsonResult> {
  const stripeCreds = await getAppCredentials<StripeAppCredentials>("stripe");
  const liveBillingError = assertLiveBillingInProd(stripeCreds);
  if (liveBillingError) return liveBillingError;

  const live = stripeCreds.secretKey.startsWith("sk_live_");
  const cacheKey = `${live ? "live" : "test"}:${stripeCreds.priceId}`;
  if (pricingCache?.key === cacheKey && pricingCache.expiresAt > Date.now()) {
    return json(200, pricingCache.value);
  }

  const stripe = createStripeClient(stripeCreds);
  const price = await stripe.prices.retrieve(stripeCreds.priceId);
  if (price.unit_amount == null || !price.recurring) {
    return json(503, { error: "billing_price_invalid" });
  }

  const value = {
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring.interval,
    trialDays: FREE_TRIAL_DAYS,
    live,
  };
  pricingCache = { key: cacheKey, expiresAt: Date.now() + PUBLIC_PRICING_CACHE_MS, value };
  return json(200, value);
}

/**
 * Public acquisition endpoint. Cognito self-signup is deliberately disabled.
 *
 * start/resend: issue a short-lived SES OTP and persist only its HMAC.
 * confirm: atomically consumes the valid OTP, then creates Cognito + tenant + Stripe.
 * GET /public/pricing: returns non-secret Stripe recurring-price metadata.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const cloudFrontRejection = requireCloudFrontOrigin(event);
  if (cloudFrontRejection) return cloudFrontRejection;

  const method = event.requestContext?.http?.method ?? "POST";
  const path = event.rawPath ?? "/signup";

  if (method === "GET" && path === "/public/pricing") {
    try {
      return await publicPricing();
    } catch (err) {
      console.error("signup: public pricing failed", (err as Error).message);
      return json(503, { error: "pricing_unavailable" });
    }
  }

  let body: SignupRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as SignupRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  try {
    switch (body.action ?? "start") {
      case "start":
        return await startSignup(body);
      case "confirm":
        return await confirmSignup(body);
      case "resend":
        return await resendConfirmation(body);
      default:
        return json(400, { error: "invalid_action" });
    }
  } catch (err) {
    console.error("signup: request failed", (err as Error).message);
    return json(500, { error: "signup_failed" });
  }
}
