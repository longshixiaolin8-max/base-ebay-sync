import { randomUUID } from "node:crypto";
import {
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  NotAuthorizedException,
  ResendConfirmationCodeCommand,
  SignUpCommand,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  createPendingTenant,
  deletePendingTenant,
  getTenantBillingStatus,
  setPendingTenantStripeCustomerId,
} from "@ai-ec/db";
import {
  createStripeClient,
  getAppCredentials,
  getDb,
  recordAuditLog,
  requireCloudFrontOrigin,
  requireEnv,
  type StripeAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

interface SignupRequestBody {
  action?: "start" | "confirm" | "resend";
  companyName?: string;
  name?: string;
  email?: string;
  password?: string;
  confirmationCode?: string;
  acceptedTerms?: boolean;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const cognitoClient = new CognitoIdentityProviderClient({});
const FREE_TRIAL_DAYS = 30;
const TERMS_VERSION = "2026-10-03";
const PRIVACY_VERSION = "2026-10-03";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertLiveBillingInProd(creds: StripeAppCredentials): APIGatewayProxyResultV2 | null {
  if (process.env.PLATFORM_ENV === "prod" && !creds.secretKey.startsWith("sk_live_")) {
    console.error("signup: production signup blocked because Stripe is not using a live secret key");
    return json(503, { error: "billing_not_live" });
  }
  return null;
}

async function getConfirmedTenantId(email: string): Promise<string | null> {
  const userPoolId = requireEnv("COGNITO_USER_POOL_ID");
  const user = await cognitoClient.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: email }));
  if (user.UserStatus !== "CONFIRMED") return null;
  return user.UserAttributes?.find((attr) => attr.Name === "custom:tenant_id")?.Value ?? null;
}

async function startSignup(body: SignupRequestBody): Promise<APIGatewayProxyResultV2> {
  const companyName = body.companyName?.trim();
  const name = body.name?.trim();
  const password = body.password;
  const email = body.email ? normalizeEmail(body.email) : "";

  if (!companyName || !email || !password || body.acceptedTerms !== true) {
    return json(400, { error: "missing_fields_or_terms" });
  }

  const tenantId = randomUUID();
  const clientId = requireEnv("COGNITO_USER_POOL_CLIENT_ID");
  const db = getDb();

  try {
    await cognitoClient.send(
      new SignUpCommand({
        ClientId: clientId,
        Username: email,
        Password: password,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "custom:tenant_id", Value: tenantId },
          ...(name ? [{ Name: "name", Value: name }] : []),
        ],
      }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) return json(409, { error: "already_registered" });
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
    // Cognito and Aurora cannot share one transaction. Compensate the Cognito side if the
    // tenant/audit write fails so a retry is not blocked by an orphaned Cognito username.
    await cognitoClient
      .send(new AdminDeleteUserCommand({ UserPoolId: requireEnv("COGNITO_USER_POOL_ID"), Username: email }))
      .catch(() => {});
    await deletePendingTenant(db, tenantId).catch(() => {});
    throw err;
  }

  return json(200, { confirmationRequired: true, email });
}

async function resendConfirmation(body: SignupRequestBody): Promise<APIGatewayProxyResultV2> {
  const email = body.email ? normalizeEmail(body.email) : "";
  if (!email) return json(400, { error: "email_required" });
  await cognitoClient.send(new ResendConfirmationCodeCommand({ ClientId: requireEnv("COGNITO_USER_POOL_CLIENT_ID"), Username: email }));
  return json(200, { resent: true });
}

async function confirmSignup(body: SignupRequestBody): Promise<APIGatewayProxyResultV2> {
  const email = body.email ? normalizeEmail(body.email) : "";
  const code = body.confirmationCode?.trim();
  if (!email || !code) return json(400, { error: "confirmation_required" });

  const clientId = requireEnv("COGNITO_USER_POOL_CLIENT_ID");

  try {
    await cognitoClient.send(new ConfirmSignUpCommand({ ClientId: clientId, Username: email, ConfirmationCode: code }));
  } catch (err) {
    // A browser retry after confirmation but before Stripe returned must remain recoverable.
    // Only continue when Cognito itself confirms the account is already CONFIRMED.
    if (!(err instanceof NotAuthorizedException) || !(await getConfirmedTenantId(email))) throw err;
  }

  const tenantId = await getConfirmedTenantId(email);
  if (!tenantId) return json(409, { error: "signup_state_missing" });

  const stripeCreds = await getAppCredentials<StripeAppCredentials>("stripe");
  const liveBillingError = assertLiveBillingInProd(stripeCreds);
  if (liveBillingError) return liveBillingError;

  const db = getDb();
  const billing = await getTenantBillingStatus(db, tenantId);
  if (!billing) return json(409, { error: "signup_state_missing" });

  const stripe = createStripeClient(stripeCreds);
  let customerId = billing.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({ email, metadata: { tenantId } });
    customerId = customer.id;
    await setPendingTenantStripeCustomerId(db, tenantId, customerId);
  }

  const adminAppUrl = requireEnv("ADMIN_APP_URL");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: stripeCreds.priceId, quantity: 1 }],
    success_url: `${adminAppUrl}/login?checkout=success`,
    cancel_url: `${adminAppUrl}/signup?checkout=cancelled`,
    metadata: { tenantId },
    subscription_data: { trial_period_days: FREE_TRIAL_DAYS },
  });

  return json(200, { checkoutUrl: session.url });
}

async function publicPricing(): Promise<APIGatewayProxyResultV2> {
  const stripeCreds = await getAppCredentials<StripeAppCredentials>("stripe");
  const liveBillingError = assertLiveBillingInProd(stripeCreds);
  if (liveBillingError) return liveBillingError;

  const stripe = createStripeClient(stripeCreds);
  const price = await stripe.prices.retrieve(stripeCreds.priceId);
  if (price.unit_amount == null || !price.recurring) {
    return json(503, { error: "billing_price_invalid" });
  }

  return json(200, {
    unitAmount: price.unit_amount,
    currency: price.currency,
    interval: price.recurring.interval,
    trialDays: FREE_TRIAL_DAYS,
    live: stripeCreds.secretKey.startsWith("sk_live_"),
  });
}

/**
 * Public acquisition endpoint.
 * GET /public/pricing exposes only Stripe's non-secret price metadata.
 * POST /signup action=start starts Cognito SignUp and sends Cognito's verification code.
 * POST /signup action=confirm verifies ownership, then creates/reuses Stripe Customer and
 * redirects to Checkout. action=resend re-sends Cognito's verification code.
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
