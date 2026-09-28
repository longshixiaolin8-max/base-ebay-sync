import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  findTenantByStripeCustomerId,
  markTenantActive,
  markTenantCanceledWithGrace,
  markTenantPastDue,
} from "@ai-ec/db";
import {
  createStripeClient,
  getAppCredentials,
  getDb,
  requireCloudFrontOrigin,
  type StripeAppCredentials,
} from "@ai-ec/lambda-shared";
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
  const cloudFrontRejection = requireCloudFrontOrigin(event);
  if (cloudFrontRejection) return cloudFrontRejection;

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

  // Inbox pattern: claiming a delivery ("safe to start on it") and completing it ("the
  // billing mutation it describes actually committed") are deliberately different states.
  // Previously these were the same INSERT -- a crash or throw anywhere after that single
  // claim (e.g. a transient DB error mid-mutation) left the row looking claimed forever,
  // and Stripe's own retry of that exact event would be met with an immediate "duplicate,
  // 200 OK" that never actually applied the tenant status change it described.
  const claim = await claimWebhookEvent(db, "stripe", stripeEvent.id);
  if (!claim.claimed) {
    if (claim.status === "completed") {
      return json(200, { received: true, duplicate: true });
    }
    // Another invocation's claim is still within its staleness window -- neither a
    // duplicate to ack nor safe to reprocess concurrently. A non-2xx here just means Stripe
    // tries again shortly, by which point that invocation will have finished (completed or
    // failed-and-reclaimable).
    return json(409, { error: "event_already_processing" });
  }

  // Stripe's own event timestamp (unix seconds), not this Lambda's clock -- lets
  // markTenant*'s out-of-order guard tell a stale, replayed event from a genuinely newer
  // one regardless of delivery order.
  const eventCreatedAt = new Date(stripeEvent.created * 1000);

  try {
    // Every mutation this event can cause, plus marking it completed, commits atomically --
    // if the mutation succeeds but marking-completed somehow doesn't (or vice versa), the
    // whole thing rolls back and the claim above is left at status "processing", where
    // catch below still gets to mark it "failed" and reclaimable.
    await db.transaction(async (tx) => {
      switch (stripeEvent.type) {
        case "checkout.session.completed": {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          const tenantId = session.metadata?.tenantId;
          const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
          const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
          if (tenantId && customerId && subscriptionId) {
            await markTenantActive(tx, tenantId, { stripeCustomerId: customerId, stripeSubscriptionId: subscriptionId }, eventCreatedAt);
          }
          break;
        }
        case "customer.subscription.updated": {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
          const tenant = await findTenantByStripeCustomerId(tx, customerId);
          if (tenant) {
            if (subscription.status === "active" || subscription.status === "trialing") {
              await markTenantActive(tx, tenant.id, { stripeCustomerId: customerId, stripeSubscriptionId: subscription.id }, eventCreatedAt);
            } else if (subscription.status === "past_due" || subscription.status === "unpaid") {
              await markTenantPastDue(tx, tenant.id, eventCreatedAt);
            } else if (subscription.status === "canceled") {
              await markTenantCanceledWithGrace(tx, tenant.id, eventCreatedAt);
            }
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
          const tenant = await findTenantByStripeCustomerId(tx, customerId);
          if (tenant) await markTenantCanceledWithGrace(tx, tenant.id, eventCreatedAt);
          break;
        }
        case "invoice.payment_failed": {
          const invoice = stripeEvent.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (customerId) {
            const tenant = await findTenantByStripeCustomerId(tx, customerId);
            if (tenant) await markTenantPastDue(tx, tenant.id, eventCreatedAt);
          }
          break;
        }
        default:
          // Every other event type is intentionally ignored -- still a successfully
          // "processed" (no-op) delivery, so it's still marked completed below.
          break;
      }

      await completeWebhookEvent(tx, "stripe", stripeEvent.id);
    });
  } catch (err) {
    await failWebhookEvent(db, "stripe", stripeEvent.id, (err as Error).message);
    // Non-2xx so Stripe retries -- the claim above is now "failed" and reclaimable on that
    // retry, rather than permanently stuck at "processing" or falsely appearing "completed".
    return json(500, { error: "processing_failed" });
  }

  return json(200, { received: true });
}
