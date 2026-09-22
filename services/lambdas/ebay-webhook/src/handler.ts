import {
  computeChallengeResponse,
  parseSignatureHeader,
  verifyNotificationSignature,
} from "@ai-ec/adapter-ebay";
import { BOOTSTRAP_TENANT_ID } from "@ai-ec/db";
import {
  createEbayAdapter,
  deleteOAuthConnectionsByExternalAccount,
  getAppCredentials,
  getDb,
  getQueueUrls,
  pollChannelSales,
  recordAuditLog,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const NOTIFICATION_LOOKBACK_MS = 20 * 60 * 1000;
const MARKETPLACE_ACCOUNT_DELETION_TOPIC = "MARKETPLACE_ACCOUNT_DELETION";

interface EbayNotificationPayload {
  metadata?: { topic?: string };
  notification?: { data?: { username?: string; userId?: string } };
}

/**
 * eBay requires every production keyset to handle this notification: when a marketplace
 * user requests their account be deleted/closed, eBay pushes this and expects any personal
 * data this app holds about that account to be removed. Deliberately does not fall through
 * to pollChannelSales below -- this is a deletion request, not a "something may have
 * changed, go check" signal.
 */
async function handleAccountDeletion(payload: EbayNotificationPayload): Promise<APIGatewayProxyResultV2> {
  const username = payload.notification?.data?.username;
  if (!username) {
    console.warn("ebay-webhook: MARKETPLACE_ACCOUNT_DELETION notification had no username, ignoring");
    return { statusCode: 204 };
  }

  const db = getDb();
  const deleted = await deleteOAuthConnectionsByExternalAccount(db, "ebay", username);
  for (const row of deleted) {
    await recordAuditLog(db, {
      tenantId: row.tenantId,
      actor: "system:ebay-webhook",
      action: "ebay_account_deletion_purge",
      entityType: "ebay_account",
      entityId: username,
      after: { secretArn: row.secretArn },
    });
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

  const db = getDb();
  const queues = getQueueUrls();
  // eBay's notification delivery carries no tenant hint at all -- unlike the other pollers,
  // there's no way to derive which tenant this webhook belongs to without a per-tenant
  // webhook-registration redesign (tracked as a deferred follow-up to the multi-tenant
  // retrofit). Hardcoded to the one bootstrap tenant, matching the one real registered
  // eBay webhook destination that exists today.
  await pollChannelSales(BOOTSTRAP_TENANT_ID, adapter, new Date(Date.now() - NOTIFICATION_LOOKBACK_MS), db, queues.inventorySync);

  return { statusCode: 204 };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === "GET") {
    return handleChallenge(event);
  }
  return handleNotification(event);
}
