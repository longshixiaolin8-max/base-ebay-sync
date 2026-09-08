import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload {
  nonce: string;
  issuedAt: number;
  /**
   * Which tenant this connect flow is for. Minted server-side from the *caller's own*
   * authenticated session (see admin-api's GET /admin/oauth/{channel}/authorize-url) --
   * never accepted as a client-supplied query param on the public /oauth/.../authorize
   * route -- otherwise anyone who could guess/discover another tenant's id could complete
   * their own OAuth consent and have it attached to the victim tenant's connection.
   */
  tenantId: string;
}

/**
 * Stateless, signed CSRF state for the OAuth authorize->callback round trip (avoids
 * needing a separate "pending states" table). The secret is the OAuth app's client
 * secret pulled from Secrets Manager, so only this platform can mint/verify a state.
 */
export function signState(secret: string, tenantId: string): string {
  const payload: StatePayload = { nonce: crypto.randomUUID(), issuedAt: Date.now(), tenantId };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/** Returns the tenantId the state was minted for, once its signature and age check out. */
export function verifyState(secret: string, state: string, maxAgeMs = 10 * 60 * 1000): string {
  const [payloadB64, signature] = state.split(".");
  if (!payloadB64 || !signature) throw new Error("Malformed OAuth state");

  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("OAuth state signature mismatch (possible CSRF attempt)");
  }

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as StatePayload;
  if (Date.now() - payload.issuedAt > maxAgeMs) {
    throw new Error("OAuth state expired");
  }
  if (!payload.tenantId) {
    throw new Error("OAuth state missing tenantId");
  }
  return payload.tenantId;
}
