import {
  claimWebhookEvent,
  completeWebhookEvent,
  failWebhookEvent,
  findTenantByStripeCustomerId,
  getTenantContact,
  markTenantActive,
  markTenantCanceledWithGrace,
  markTenantPastDue,
  type Database,
} from "@ai-ec/db";
import {
  createStripeClient,
  getAppCredentials,
  getDb,
  requireCloudFrontOrigin,
  sendEmail,
  type StripeAppCredentials,
} from "@ai-ec/lambda-shared";
import type Stripe from "stripe";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

type BillingNoticeKind = "past_due" | "canceled_grace";

function billingNoticeContent(kind: BillingNoticeKind, tenantName: string, gracePeriodEndsAt?: Date): { subject: string; bodyText: string } {
  if (kind === "past_due") {
    return {
      subject: "【AI EC Platform】お支払いに失敗しました",
      bodyText: `${tenantName} 様\n\nご登録のお支払い方法での決済に失敗しました。サービスの継続利用のため、Stripeの請求ポータルからお支払い方法をご確認・更新ください。\n\n既存の出品・在庫同期は引き続き稼働していますが、お支払いが確認できない状態が続くと、いずれ制限される場合があります。`,
    };
  }
  const untilText = gracePeriodEndsAt ? gracePeriodEndsAt.toISOString().slice(0, 10) : "";
  return {
    subject: "【AI EC Platform】サブスクリプションが解約されました",
    bodyText: `${tenantName} 様\n\nサブスクリプションの解約が確認されました。既存の出品・在庫同期は${untilText ? `${untilText}まで` : "しばらくの間"}引き続き稼働しますが、その後は利用いただけなくなります。\n\n継続を希望される場合は、管理画面の請求設定からいつでも再開いただけます。`,
  };
}

/**
 * Fires after the tenant-status mutation has already committed -- never inside the same
 * db.transaction() as the mutation itself, since a slow/failing SES call must never roll
 * back (or delay completing) the actual billing state change or webhook ack. Always
 * caught by the caller: a delivery failure here is logged and otherwise ignored, matching
 * every other notification type in this codebase (see packages/db/src/tenants.ts's own
 * "persisted but not necessarily delivered" framing) -- Stripe's own retry/dashboard is
 * the durable record of the billing event itself, this is a best-effort courtesy email.
 */
async function sendBillingNoticeEmail(
  db: Database,
  tenantId: string,
  kind: BillingNoticeKind,
  gracePeriodEndsAt?: Date,
): Promise<void> {
  const contact = await getTenantContact(db, tenantId);
  if (!contact || !contact.contactEmail || !contact.notificationPreferences.billingNotice) return;
  const { subject, bodyText } = billingNoticeContent(kind, contact.name, gracePeriodEndsAt);
  await sendEmail({ to: contact.contactEmail, subject, bodyText });
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

  // Set inside the transaction below ONLY when a mark* call actually applied (not stale/
  // no-op'd) a past_due or canceled_grace transition -- read back after the transaction
  // commits to decide whether to send a billing-notice email. Never set for markTenantActive:
  // a "payment succeeded"/reactivation email isn't part of this round's scope.
  let billingNotice: { tenantId: string; kind: BillingNoticeKind; gracePeriodEndsAt?: Date } | null = null;

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
              const applied = await markTenantPastDue(tx, tenant.id, eventCreatedAt);
              if (applied) billingNotice = { tenantId: tenant.id, kind: "past_due" };
            } else if (subscription.status === "canceled") {
              const result = await markTenantCanceledWithGrace(tx, tenant.id, eventCreatedAt);
              if (result.applied) billingNotice = { tenantId: tenant.id, kind: "canceled_grace", gracePeriodEndsAt: result.gracePeriodEndsAt };
            }
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
          const tenant = await findTenantByStripeCustomerId(tx, customerId);
          if (tenant) {
            const result = await markTenantCanceledWithGrace(tx, tenant.id, eventCreatedAt);
            if (result.applied) billingNotice = { tenantId: tenant.id, kind: "canceled_grace", gracePeriodEndsAt: result.gracePeriodEndsAt };
          }
          break;
        }
        case "invoice.payment_failed": {
          const invoice = stripeEvent.data.object as Stripe.Invoice;
          const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
          if (customerId) {
            const tenant = await findTenantByStripeCustomerId(tx, customerId);
            if (tenant) {
              const applied = await markTenantPastDue(tx, tenant.id, eventCreatedAt);
              if (applied) billingNotice = { tenantId: tenant.id, kind: "past_due" };
            }
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

  if (billingNotice) {
    // Deliberately outside the transaction (already committed above) and deliberately never
    // awaited into the response path's failure handling -- see sendBillingNoticeEmail's own
    // doc comment. Stripe already got the real outcome (the transaction committed); a
    // delivery failure here must never turn into a 500 that makes Stripe retry a billing
    // mutation that already, correctly, applied.
    const notice: { tenantId: string; kind: BillingNoticeKind; gracePeriodEndsAt?: Date } = billingNotice;
    await sendBillingNoticeEmail(db, notice.tenantId, notice.kind, notice.gracePeriodEndsAt).catch((err) => {
      console.error("stripe-webhook: failed to send billing notice email", (err as Error).message);
    });
  }

  return json(200, { received: true });
}
