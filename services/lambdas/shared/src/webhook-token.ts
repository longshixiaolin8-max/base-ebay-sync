import { createHmac, timingSafeEqual } from "node:crypto";

interface TokenPayload {
  tenantId: string;
}

/**
 * Signs a per-tenant, non-expiring token embedded in a webhook destination URL this
 * platform controls the registration of (see admin-api's
 * POST /admin/ebay/platform-notification-setup). Two purposes at once: it's the
 * "secret/tokenを含むendpoint設計" this round's hardening calls for (an attacker can no
 * longer flood a fully-guessable, static path), and it's what lets the delivery handler
 * know *which tenant* a notification is for -- eBay's legacy Platform Notifications carry
 * no tenant hint of their own, unlike the OAuth authorize/callback round trip oauth-state.ts
 * protects, this token is minted once and must keep verifying for the life of the
 * subscription, so (unlike oauth-state's signState/verifyState) it deliberately has no
 * expiry -- there is no round trip to bound the age of.
 */
export function signWebhookDestinationToken(secret: string, tenantId: string): string {
  const payload: TokenPayload = { tenantId };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/** Returns the tenantId a token was minted for, once its signature checks out. */
export function verifyWebhookDestinationToken(secret: string, token: string): string {
  const [payloadB64, signature] = token.split(".");
  if (!payloadB64 || !signature) throw new Error("Malformed webhook destination token");

  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Webhook destination token signature mismatch (possible forged/tampered URL)");
  }

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as TokenPayload;
  if (!payload.tenantId) {
    throw new Error("Webhook destination token missing tenantId");
  }
  return payload.tenantId;
}
