import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeChallengeResponse,
  formatPublicKeyPem,
  parseSignatureHeader,
  verifyNotificationSignature,
} from "./notification.js";

describe("computeChallengeResponse", () => {
  it("is a stable sha256 hex digest that changes with any input", () => {
    const result = computeChallengeResponse("123", "my-verification-token", "https://example.com/webhook");
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs must always produce the same hash.
    expect(computeChallengeResponse("123", "my-verification-token", "https://example.com/webhook")).toBe(result);
    // Different challenge code must produce a different hash.
    expect(computeChallengeResponse("456", "my-verification-token", "https://example.com/webhook")).not.toBe(result);
  });
});

describe("parseSignatureHeader", () => {
  it("decodes the base64 JSON header", () => {
    const raw = { alg: "ECDSA", kid: "key-1", signature: "c2ln", digest: "SHA1" };
    const encoded = Buffer.from(JSON.stringify(raw)).toString("base64");
    expect(parseSignatureHeader(encoded)).toEqual(raw);
  });
});

describe("formatPublicKeyPem", () => {
  it("leaves an already-PEM-wrapped key untouched", () => {
    const pem = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n";
    expect(formatPublicKeyPem(pem)).toBe(pem);
  });

  it("wraps a bare base64 key body into PEM format", () => {
    const bare = "A".repeat(100);
    const wrapped = formatPublicKeyPem(bare);
    expect(wrapped).toMatch(/^-----BEGIN PUBLIC KEY-----\n/);
    expect(wrapped).toMatch(/-----END PUBLIC KEY-----\n$/);
    expect(wrapped).toContain(bare.slice(0, 64));
  });
});

describe("verifyNotificationSignature", () => {
  it("accepts a signature produced with the matching private key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const body = JSON.stringify({ metadata: { topic: "LISTING" }, notification: { data: { sku: "SKU-1" } } });
    const signature = cryptoSign("sha1", Buffer.from(body), privateKey);
    const header = Buffer.from(
      JSON.stringify({ alg: "ECDSA", kid: "key-1", signature: signature.toString("base64"), digest: "SHA1" }),
    ).toString("base64");

    const ok = verifyNotificationSignature(body, header, {
      algorithm: "ECDSA",
      digest: "SHA1",
      key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    expect(ok).toBe(true);
  });

  it("rejects a signature that does not match the body", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const signature = cryptoSign("sha1", Buffer.from("original body"), privateKey);
    const header = Buffer.from(
      JSON.stringify({ alg: "ECDSA", kid: "key-1", signature: signature.toString("base64"), digest: "SHA1" }),
    ).toString("base64");

    const ok = verifyNotificationSignature("tampered body", header, {
      algorithm: "ECDSA",
      digest: "SHA1",
      key: publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    expect(ok).toBe(false);
  });

  it("rejects a signature produced with a different key", () => {
    const signer = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const body = "some notification body";
    const signature = cryptoSign("sha1", Buffer.from(body), signer.privateKey);
    const header = Buffer.from(
      JSON.stringify({ alg: "ECDSA", kid: "key-1", signature: signature.toString("base64"), digest: "SHA1" }),
    ).toString("base64");

    const ok = verifyNotificationSignature(body, header, {
      algorithm: "ECDSA",
      digest: "SHA1",
      key: other.publicKey.export({ type: "spki", format: "pem" }).toString(),
    });

    expect(ok).toBe(false);
  });
});
