import { createHmac, timingSafeEqual } from "node:crypto";

interface StatePayload {
  nonce: string;
  issuedAt: number;
}

/**
 * Stateless, signed CSRF state for the OAuth authorize->callback round trip (avoids
 * needing a separate "pending states" table). The secret is the OAuth app's client
 * secret pulled from Secrets Manager, so only this platform can mint/verify a state.
 */
export function signState(secret: string): string {
  const payload: StatePayload = { nonce: crypto.randomUUID(), issuedAt: Date.now() };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

export function verifyState(secret: string, state: string, maxAgeMs = 10 * 60 * 1000): void {
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
}
