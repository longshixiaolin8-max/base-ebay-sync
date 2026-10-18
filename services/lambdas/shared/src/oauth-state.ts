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
  // The OAuth state is an untrusted query parameter until its signature is
  // verified. Bound processing cost and strictly reject extra segments.
  if (state.length > 1024 || state.split(".").length !== 2) {
    throw new Error("Malformed OAuth state");
  }
  const [payloadB64, signature] = state.split(".");
  if (!payloadB64 || !signature ||
      !/^[A-Za-z0-9_-]+$/.test(payloadB64) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    throw new Error("Malformed OAuth state");
  }

  const expected = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("OAuth state signature mismatch (possible CSRF attempt)");
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw new Error("Malformed OAuth state");
  }
  if (typeof payload?.tenantId !== "string" || payload.tenantId.length === 0 || payload.tenantId.length > 128) {
    throw new Error("OAuth state missing tenantId");
  }
  if (typeof payload.nonce !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.nonce)) {
    throw new Error("Malformed OAuth state nonce");
  }
  if (!Number.isSafeInteger(payload.issuedAt)) {
    throw new Error("Malformed OAuth state timestamp");
  }
  const age = Date.now() - payload.issuedAt;
  // A signed state from an unrealistically future clock must never persist
  // indefinitely. Allow at most one minute of legitimate clock skew.
  if (age > maxAgeMs || age < -60_000) {
    throw new Error("OAuth state expired");
  }
  return payload.tenantId;
}
