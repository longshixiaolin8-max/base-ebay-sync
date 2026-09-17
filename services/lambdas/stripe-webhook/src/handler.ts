import {
  claimWebhookEvent,
  findTenantByStripeCustomerId,
  markTenantActive,
  markTenantCanceledWithGrace,
  markTenantPastDue,
} from "@ai-ec/db";
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

  // Dedup first, before any status mutation: Stripe retries on non-2xx and can occasionally
  // redeliver an already-processed event, and a second application of e.g.
  // "checkout.session.completed" would be harmless here but the general pattern (were a
  // future event type not idempotent) is worth guarding once, centrally.
  const isNewDelivery = await claimWebhookEvent(db, "stripe", stripeEvent.id);
  if (!isNewDelivery) {
    return json(200, { received: true, duplicate: true });
  }

  // Stripe's own event timestamp (unix seconds), not this Lambda's clock -- lets
  // markTenant*'s out-of-order guard tell a stale, replayed event from a genuinely newer
  // one regardless of delivery order.
  const eventCreatedAt = new Date(stripeEvent.created * 1000);

  switch (stripeEvent.type) {
    case "checkout.session.completed": {
      const session = stripeEvent.data.object as Stripe.Checkout.Session;
      const tenantId = session.metadata?.tenantId;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
      if (tenantId && customerId && subscriptionId) {
        await markTenantActive(db, tenantId, { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId }, eventCreatedAt);
      }
      break;
    }
    case "customer.subscription.updated": {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const tenant = await findTenantByStripeCustomerId(db, customerId);
      if (tenant) {
        if (subscription.status === "active" || subscription.status === "trialing") {
          await markTenantActive(db, tenant.id, { stripeCustomerId: customerId, stripeSubscriptionId: subscription.id }, eventCreatedAt);
        } else if (subscription.status === "past_due" || subscription.status === "unpaid") {
          await markTenantPastDue(db, tenant.id, eventCreatedAt);
        } else if (subscription.status === "canceled") {
          await markTenantCanceledWithGrace(db, tenant.id, eventCreatedAt);
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      const subscription = stripeEvent.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
      const tenant = await findTenantByStripeCustomerId(db, customerId);
      if (tenant) await markTenantCanceledWithGrace(db, tenant.id, eventCreatedAt);
      break;
    }
    case "invoice.payment_failed": {
      const invoice = stripeEvent.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const tenant = await findTenantByStripeCustomerId(db, customerId);
        if (tenant) await markTenantPastDue(db, tenant.id, eventCreatedAt);
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
