import {
  computeChallengeResponse,
  parseSignatureHeader,
  verifyNotificationSignature,
} from "@ai-ec/adapter-ebay";
import { buildIdempotencyKey, type ChannelType } from "@ai-ec/core";
import { BOOTSTRAP_TENANT_ID } from "@ai-ec/db";
import {
  createEbayAdapter,
  deleteOAuthConnectionsByExternalAccount,
  enqueue,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
  getQueueUrls,
  pollChannelSales,
  recordAuditLog,
  recordSyncError,
  verifyWebhookDestinationToken,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSEvent, SQSHandler } from "aws-lambda";

const NOTIFICATION_LOOKBACK_MS = 20 * 60 * 1000;
const MARKETPLACE_ACCOUNT_DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";
const PLATFORM_NOTIFICATION_PATH = "/webhooks/ebay/platform-notifications";
// A flood of legitimate-looking notifications for the same tenant/channel within this
// window collapses into at most one actual eBay poll -- the debounce half of round 14's
// "eBay Platform Notification abuse対策". Reuses the idempotency_keys store as a pure
// rate-limit mutex: tryClaim never gets complete()'d here, so a claim simply blocks any
// further claim until it goes stale past this TTL and becomes reclaimable again (see
// idempotency-store.ts's own fix for exactly this reclaim condition).
const POLL_DEBOUNCE_SECONDS = 20;

interface EbayNotificationPayload {
  metadata?: { topic?: string };
  notification?: { data?: { username?: string; userId?: string } };
}

interface PollRequestMessage {
  tenantId: string;
  channel: ChannelType;
}

/**
 * Debounces and dispatches a "poll this tenant/channel now" request onto
 * ebayPlatformNotificationPoll rather than calling pollChannelSales inline -- the actual
 * fix for "HTTP request 1回 = eBay poll 1回" this round targets. A flood of requests within
 * POLL_DEBOUNCE_SECONDS all lose the claim after the first and are simply dropped (this
 * function still returns normally -- the caller still acks the notification either way);
 * only the winner's single enqueue ever reaches SQS, and dispatchPoll below is the only
 * thing that ever actually calls pollChannelSales.
 */
async function triggerCoalescedPoll(tenantId: string, channel: ChannelType): Promise<void> {
  const idempotencyStore = getIdempotencyStore(tenantId);
  const key = buildIdempotencyKey(tenantId, ["ebay_notification_poll", channel]);
  const claim = await idempotencyStore.tryClaim(key, POLL_DEBOUNCE_SECONDS);
  if (claim) return; // another notification already triggered a poll within the debounce window

  const queues = getQueueUrls();
  const message: PollRequestMessage = { tenantId, channel };
  await enqueue(queues.ebayPlatformNotificationPoll, message);
}

/**
 * eBay requires every production keyset to handle this notification: when a marketplace
 * user requests their account be deleted/closed, eBay pushes this and expects any personal
 * data this app holds about that account to be removed. Deliberately does not fall through
 * to pollChannelSales below -- this is a deletion request, not a "something may have
 * changed, go check" signal.
 *
 * Keyed on userId, not username: oauth_connections' externalAccountId for eBay is now
 * itself the immutable userId returned by getAuthenticatedUserId (the tenant-isolation fix
 * that replaced this app's own "default" externalAccountId fallback), so this must match on
 * the same field to ever find anything to purge. This also matches eBay's own direction here
 * -- as of September 26 2025, for affected regions eBay's notification.data.username field
 * itself now carries the immutable userId value rather than a real username (confirmed
 * against eBay's own AsyncAPI schema and developer-facing data-handling-update notice),
 * so userId is both the more reliable and the only-ever-populated identifier to key on.
 *
 * Naturally idempotent: a redelivery of the same notification finds no matching
 * oauth_connections rows left the second time (the DELETE simply returns zero rows, and
 * DeleteSecretCommand's own ResourceNotFoundException is already tolerated), so it safely
 * no-ops rather than erroring or double-purging.
 *
 * Failure handling doubles as this notification's compliance requirement: eBay resends an
 * unacknowledged MARKETPLACE_ACCOUNT_DELETION notification (any of 200/201/202/204 counts
 * as acknowledged) and marks a callback URL down after 24h of failures, alerting the
 * developer -- so a genuine processing failure here must return a non-2xx (to trigger
 * eBay's own retry) rather than the 204 that would normally mean "done," and must be
 * recorded somewhere a human can see it, not just in CloudWatch logs.
 */
async function handleAccountDeletion(payload: EbayNotificationPayload): Promise<APIGatewayProxyResultV2> {
  const userId = payload.notification?.data?.userId;
  if (!userId) {
    console.warn("ebay-webhook: MARKETPLACE_ACCOUNT_DELETION notification had no userId, ignoring");
    return { statusCode: 204 };
  }

  const db = getDb();
  try {
    const deleted = await deleteOAuthConnectionsByExternalAccount(db, "ebay", userId);
    for (const row of deleted) {
      await recordAuditLog(db, {
        tenantId: row.tenantId,
        actor: "system:ebay-webhook",
        action: "ebay_account_deletion_purge",
        entityType: "ebay_account",
        entityId: userId,
        after: { secretArn: row.secretArn },
      });
    }
  } catch (err) {
    // No single tenant is reliably known here (the delete itself may have failed before
    // returning which rows it would have touched) -- logged against BOOTSTRAP_TENANT_ID,
    // this file's existing fallback for signals that don't carry a real per-tenant hint,
    // so a human still sees this in the sync-errors dashboard rather than only in logs.
    await recordSyncError(db, {
      tenantId: BOOTSTRAP_TENANT_ID,
      channel: "ebay",
      productId: null,
      errorCode: "ebay_account_deletion_failed",
      errorMessage: (err as Error).message,
      payload: { userId },
    });
    return { statusCode: 500 };
  }

  return { statusCode: 204 };
}

/**
 * GET /webhooks/ebay/notifications?challenge_code=... — eBay's one-time endpoint-ownership
 * check, sent immediately when a Notification API destination pointing at this URL is created.
 */
async function handleChallenge(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const challengeCode = event.queryStringParameters?.challenge_code;
  if (!challengeCode) return { statusCode: 400, body: "Missing challenge_code" };

  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  if (!creds.webhookVerificationToken) {
    return { statusCode: 500, body: "webhookVerificationToken is not configured" };
  }
  const endpoint = process.env.EBAY_WEBHOOK_ENDPOINT_URL;
  if (!endpoint) return { statusCode: 500, body: "EBAY_WEBHOOK_ENDPOINT_URL is not configured" };

  const challengeResponse = computeChallengeResponse(challengeCode, creds.webhookVerificationToken, endpoint);
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeResponse }),
  };
}

/**
 * POST /webhooks/ebay/notifications — an actual event delivery. Only ever used as a "poll
 * eBay now" trigger: the notification body is never treated as authoritative sale data.
 * Even a forged or malformed delivery can, at worst, cause one extra Fulfillment API poll —
 * the real sale facts always come from listRecentSales() via the eBay Orders API.
 */
async function handleNotification(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const rawBody = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf-8") : event.body ?? "";
  const signatureHeader = event.headers?.["x-ebay-signature"] ?? event.headers?.["X-EBAY-SIGNATURE"];

  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  const adapter = createEbayAdapter(creds);

  if (signatureHeader) {
    try {
      const { kid } = parseSignatureHeader(signatureHeader);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const publicKey = await adapter.getNotificationPublicKey(appAccessToken, kid);
      const verified = verifyNotificationSignature(rawBody, signatureHeader, publicKey);
      if (!verified) {
        console.warn("ebay-webhook: signature verification failed, ignoring delivery");
        return { statusCode: 412 };
      }
    } catch (err) {
      console.warn("ebay-webhook: could not verify signature, ignoring delivery", (err as Error).message);
      return { statusCode: 412 };
    }
  } else {
    console.warn("ebay-webhook: notification had no X-EBAY-SIGNATURE header, ignoring delivery");
    return { statusCode: 412 };
  }

  let payload: EbayNotificationPayload = {};
  try {
    payload = JSON.parse(rawBody) as EbayNotificationPayload;
  } catch {
    // Malformed body -- fall through to the default "poll now" handling below, matching
    // this endpoint's existing stance that a notification body is never authoritative.
  }

  if (payload.metadata?.topic === MARKETPLACE_ACCOUNT_DELETION_TOPIC) {
    return handleAccountDeletion(payload);
  }

  // eBay's notification delivery carries no tenant hint at all -- unlike the other pollers,
  // there's no way to derive which tenant this webhook belongs to without a per-tenant
  // webhook-registration redesign (this is the same limitation round 14's
  // platform-notifications fix below solves via a per-tenant signed destination token, but
  // this REST path is a different, already X-EBAY-SIGNATURE-verified delivery mechanism --
  // extending the same per-tenant redesign here is out of this round's scope). Hardcoded to
  // the one bootstrap tenant, matching the one real registered eBay webhook destination
  // that exists today. Routed through triggerCoalescedPoll (not a direct pollChannelSales
  // call) so a burst of otherwise-legitimate, signature-verified notifications still can't
  // amplify 1:1 into eBay API calls.
  await triggerCoalescedPoll(BOOTSTRAP_TENANT_ID, "ebay");

  return { statusCode: 204 };
}

/**
 * POST /webhooks/ebay/platform-notifications/{token} — delivery target for the legacy
 * Trading API's Platform Notifications (SetNotificationPreferences), used for the
 * FixedPriceTransaction event. This is a wholly different delivery mechanism from the REST
 * Notification API above (XML/SOAP-flavored body, no X-EBAY-SIGNATURE, no challenge_code) --
 * so unlike that path, this one has no per-request crypto verification available at all.
 *
 * The {token} path segment is this route's own authenticity + tenant-dispatch mechanism
 * (round 14 hardening): a per-tenant, HMAC-signed token minted once at subscription time
 * (see admin-api's POST /admin/ebay/platform-notification-setup) and verified here. Still
 * never treats the body as authoritative sale data -- receipt of a validly-tokened request
 * is only ever a "go poll this tenant now" signal, debounced and dispatched via
 * triggerCoalescedPoll so a flood of requests (forged or not) can't amplify into repeated
 * synchronous eBay API calls; the real sale facts still only ever come from
 * listRecentSales() via dispatchPoll below.
 */
async function handlePlatformNotification(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const token = event.pathParameters?.token;
  if (!token) return { statusCode: 404 };

  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  let tenantId: string;
  try {
    tenantId = verifyWebhookDestinationToken(creds.clientSecret, token);
  } catch (err) {
    console.warn("ebay-webhook: platform-notifications token invalid, ignoring delivery", (err as Error).message);
    return { statusCode: 403 };
  }

  await triggerCoalescedPoll(tenantId, "ebay");
  return { statusCode: 200 };
}

/**
 * SQS consumer for ebayPlatformNotificationPoll -- the only thing that actually calls
 * pollChannelSales for a webhook-triggered poll. Deployed as its own Lambda
 * (EbayPlatformNotificationDispatcher in infra/lib/lambda-stack.ts) from this same file,
 * off the public webhook's own request path entirely.
 */
export const dispatchPoll: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const queues = getQueueUrls();
  const creds = await getAppCredentials<EbayAppCredentials>("ebay");
  const adapter = createEbayAdapter(creds);
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const { tenantId } = JSON.parse(record.body) as PollRequestMessage;
      await pollChannelSales(tenantId, adapter, new Date(Date.now() - NOTIFICATION_LOOKBACK_MS), db, queues.inventorySync);
    } catch (err) {
      console.error("ebay-webhook dispatchPoll: poll failed, will retry via SQS redelivery", (err as Error).message);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.rawPath.startsWith(`${PLATFORM_NOTIFICATION_PATH}/`) && event.requestContext.http.method === "POST") {
    return handlePlatformNotification(event);
  }
  if (event.requestContext.http.method === "GET") {
    return handleChallenge(event);
  }
  return handleNotification(event);
}
