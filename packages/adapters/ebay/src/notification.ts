import { createHash, verify as cryptoVerify } from "node:crypto";

export interface EbayPublicKey {
  algorithm: string;
  digest: string;
  key: string;
}

interface DecodedSignatureHeader {
  alg: string;
  kid: string;
  signature: string;
  digest: string;
}

/**
 * eBay's endpoint-verification challenge response: SHA-256(challengeCode + verificationToken +
 * endpoint), hex-encoded. Sent back as { "challengeResponse": "<hex>" } to eBay's GET
 * ?challenge_code=... request when registering a notification destination.
 */
export function computeChallengeResponse(challengeCode: string, verificationToken: string, endpoint: string): string {
  return createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");
}

/** Decodes the base64 X-EBAY-SIGNATURE header into its {alg, kid, signature, digest} JSON. */
export function parseSignatureHeader(headerValue: string): DecodedSignatureHeader {
  return JSON.parse(Buffer.from(headerValue, "base64").toString("utf-8")) as DecodedSignatureHeader;
}

/** eBay's public_key API can return a bare base64 key body without PEM wrapping; normalize it. */
export function formatPublicKeyPem(rawKey: string): string {
  if (rawKey.includes("-----BEGIN")) return rawKey;
  const body = rawKey.match(/.{1,64}/g)?.join("\n") ?? rawKey;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

/**
 * Verifies an inbound eBay notification's signature. Not a hard trust boundary for this
 * platform's correctness: a passing/failing result only decides whether ebay-webhook treats
 * the delivery as a trigger to run an authoritative sales poll early -- the actual sale data
 * always comes from eBay's Fulfillment API, never from the webhook body itself.
 */
export function verifyNotificationSignature(
  rawBody: string,
  signatureHeaderValue: string,
  publicKey: EbayPublicKey,
): boolean {
  const decoded = parseSignatureHeader(signatureHeaderValue);
  const digestAlgorithm = (publicKey.digest || decoded.digest || "SHA1").toLowerCase();
  const pem = formatPublicKeyPem(publicKey.key);
  const signature = Buffer.from(decoded.signature, "base64");
  return cryptoVerify(digestAlgorithm, Buffer.from(rawBody, "utf-8"), pem, signature);
}
