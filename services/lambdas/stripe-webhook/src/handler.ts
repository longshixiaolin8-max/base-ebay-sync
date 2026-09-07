import { findTenantByStripeCustomerId, markTenantActive, markTenantInactive } from "@ai-ec/db";
import { createStripeClient, getAppCredentials, getDb, type StripeAppCredentials } from "@ai-ec/lambda-shared";
import type Stripe from "stripe";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

/**
 * POST /webhooks/stripe -- public, like /webhooks/ebay/notifications: no Cognito session
 * exists on this call, so authenticity relies entirely on Stripe's own signature (verified
 * below via the stored webhook signing secret), not this route's auth gate.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const signatureHeader = event.headers?.["stripe-signature"] ?? event.headers?.["Stripe-Signature"];
  if (!signatureHeader) {
    return json(400, { error: "missing_signature" });
  }

  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64") : (event.body ?? "");

  const creds = await getAppCredentials<StripeAppCredentials>("stripe");
  const stripe = createStripeClient(creds);

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signatureHeader, creds.webhookSigningSecret);
  } catch (err) {
    console.warn("stripe-webhook: signature verification failed, ignoring delivery", (err as Error).message);
    return json(400, { error: "invalid_signature" });
  }

  const db = getDb();

  switch (stripeEvent.type) {
    case "checkout.session.completed": {
      const session = stripeEvent.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenantId;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (tenantId && customerId && subscriptionId) {
        await markTenantActive(db, tenantId, { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId });
      }
      break;
    }
    case "customer.subscription.updated": {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const tenant = await findTenantByStripeCustomerId(db, customerId);
      if (tenant) {
        if (subscription.status === "active" || subscription.status === "trialing") {
          await markTenantActive(db, tenant.id, { stripeCustomerId: customerId, stripeSubscriptionId: subscription.id });
        } else if (subscription.status === "past_due" || subscription.status === "unpaid") {
          await markTenantInactive(db, tenant.id, "past_due");
        } else if (subscription.status === "canceled") {
          await markTenantInactive(db, tenant.id, "canceled");
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const tenant = await findTenantByStripeCustomerId(db, customerId);
      if (tenant) await markTenantInactive(db, tenant.id, "canceled");
      break;
    }
    case "invoice.payment_failed": {
      const invoice = stripeEvent.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const tenant = await findTenantByStripeCustomerId(db, customerId);
        if (tenant) await markTenantInactive(db, tenant.id, "past_due");
      }
      break;
    }
    default:
      // Every other event type is intentionally ignored -- Stripe retries on non-2xx, so
      // always return 200 rather than treating an unhandled type as a failure.
      break;
  }

  return json(200, { received: true });
}
