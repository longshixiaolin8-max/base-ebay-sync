import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signWebhookDestinationToken, verifyWebhookDestinationToken } from "./webhook-token.js";

const SECRET = "ebay-client-secret";
const TENANT_ID = "tenant-a";

function signPayload(secret: string, payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

describe("signWebhookDestinationToken / verifyWebhookDestinationToken", () => {
  it("round-trips: a token signWebhookDestinationToken mints verifies back to the same tenantId", () => {
    const token = signWebhookDestinationToken(SECRET, TENANT_ID);
    expect(verifyWebhookDestinationToken(SECRET, token)).toBe(TENANT_ID);
  });

  it("rejects a token signed with a different secret (forged)", () => {
    const token = signWebhookDestinationToken("some-other-secret", TENANT_ID);
    expect(() => verifyWebhookDestinationToken(SECRET, token)).toThrow(/signature mismatch/i);
  });

  it("rejects a token whose payload was tampered with after signing", () => {
    const token = signWebhookDestinationToken(SECRET, TENANT_ID);
    const [payloadB64, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as { tenantId: string };
    const tampered = `${Buffer.from(JSON.stringify({ ...payload, tenantId: "victim-tenant" })).toString("base64url")}.${signature}`;

    expect(() => verifyWebhookDestinationToken(SECRET, tampered)).toThrow(/signature mismatch/i);
  });

  it("rejects a malformed token", () => {
    expect(() => verifyWebhookDestinationToken(SECRET, "not-a-real-token")).toThrow(/malformed/i);
  });

  it("never expires -- unlike oauth-state's signState/verifyState, there is no round trip to bound the age of", () => {
    // No maxAgeMs parameter exists on verifyWebhookDestinationToken at all; a token minted
    // long ago must keep verifying for the life of the eBay subscription it was registered
    // with. This test is really documentation-by-typechecking (the call below only compiles
    // because the function takes no third argument) plus a sanity round-trip.
    const token = signWebhookDestinationToken(SECRET, TENANT_ID);
    expect(verifyWebhookDestinationToken(SECRET, token)).toBe(TENANT_ID);
  });

  it("rejects a validly-signed payload with no tenantId at all", () => {
    const token = signPayload(SECRET, { nonce: "n" });
    expect(() => verifyWebhookDestinationToken(SECRET, token)).toThrow(/tenantId/i);
  });

  it("mints a different token for a different tenant, and each only ever verifies to its own tenant", () => {
    const tokenA = signWebhookDestinationToken(SECRET, "tenant-a");
    const tokenB = signWebhookDestinationToken(SECRET, "tenant-b");
    expect(tokenA).not.toBe(tokenB);
    expect(verifyWebhookDestinationToken(SECRET, tokenA)).toBe("tenant-a");
    expect(verifyWebhookDestinationToken(SECRET, tokenB)).toBe("tenant-b");
  });
});
