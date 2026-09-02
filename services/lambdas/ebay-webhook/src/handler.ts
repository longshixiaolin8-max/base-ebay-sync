import {
  computeChallengeResponse,
  parseSignatureHeader,
  verifyNotificationSignature,
} from "@ai-ec/adapter-ebay";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  getQueueUrls,
  pollChannelSales,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const NOTIFICATION_LOOKBACK_MS = 20 * 60 * 1000;

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

  const db = getDb();
  const queues = getQueueUrls();
  await pollChannelSales(adapter, new Date(Date.now() - NOTIFICATION_LOOKBACK_MS), db, queues.inventorySync);

  return { statusCode: 204 };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method === "GET") {
    return handleChallenge(event);
  }
  return handleNotification(event);
}
