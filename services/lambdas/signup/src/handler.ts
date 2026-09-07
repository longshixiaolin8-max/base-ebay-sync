import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  UsernameExistsException,
} from "@aws-sdk/client-cognito-identity-provider";
import { createPendingTenant } from "@ai-ec/db";
import { createStripeClient, getAppCredentials, getDb, requireEnv, type StripeAppCredentials } from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

interface SignupCredentials {
  inviteCode: string;
}

interface SignupRequestBody {
  companyName?: string;
  email?: string;
  password?: string;
  inviteCode?: string;
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const cognitoClient = new CognitoIdentityProviderClient({});

/**
 * POST /signup -- public (no Cognito session exists yet, this is what creates one). Beta
 * access is gated by a single shared invite code (see secrets-stack.ts's signupCredentials),
 * not per-user invites or fully open self-signup. Creates a new, fully isolated tenant plus
 * its Cognito operator account, then hands the browser off to a real (test-mode) Stripe
 * Checkout session -- the tenant stays `pending_payment` (see packages/db's billing.ts)
 * until the Stripe webhook confirms the subscription is actually active.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  let body: SignupRequestBody;
  try {
    body = JSON.parse(event.body ?? "{}") as SignupRequestBody;
  } catch {
    return json(400, { error: "invalid_json" });
  }

  const { companyName, email, password, inviteCode } = body;
  if (!companyName || !email || !password || !inviteCode) {
    return json(400, { error: "missing_fields" });
  }

  const signupCreds = await getAppCredentials<SignupCredentials>("signup");
  if (inviteCode !== signupCreds.inviteCode) {
    return json(403, { error: "invalid_invite_code" });
  }

  const db = getDb();
  const tenant = await createPendingTenant(db, companyName);
  const userPoolId = requireEnv("COGNITO_USER_POOL_ID");

  try {
    await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: userPoolId,
        Username: email,
        UserAttributes: [
          { Name: "email", Value: email },
          { Name: "email_verified", Value: "true" },
          { Name: "custom:tenant_id", Value: tenant.id },
        ],
        TemporaryPassword: password,
        MessageAction: "SUPPRESS",
      }),
    );
    // Immediately promote the temporary password to permanent with the same value, so the
    // operator's first real sign-in skips Cognito's CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED
    // challenge and goes straight into the existing TOTP-setup screen -- no changes needed to
    // the login page, which already handles that stage for admin-provisioned accounts.
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: email, Password: password, Permanent: true }),
    );
  } catch (err) {
    if (err instanceof UsernameExistsException) {
      return json(409, { error: "already_registered" });
    }
    throw err;
  }

  const stripeCreds = await getAppCredentials<StripeAppCredentials>("stripe");
  const stripe = createStripeClient(stripeCreds);
  const adminAppUrl = requireEnv("ADMIN_APP_URL");

  const customer = await stripe.customers.create({ email, metadata: { tenantId: tenant.id } });
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price: stripeCreds.priceId, quantity: 1 }],
    success_url: `${adminAppUrl}/login?checkout=success`,
    cancel_url: `${adminAppUrl}/signup`,
    // The webhook's checkout.session.completed handler needs to know which tenant this
    // is for on its very *first* event, before tenants.stripe_customer_id has ever been
    // set -- carrying tenantId on the session itself (present directly in that event's
    // payload) avoids a bootstrapping problem an id-reverse-lookup can't solve.
    metadata: { tenantId: tenant.id },
  });

  return json(200, { checkoutUrl: session.url });
}
