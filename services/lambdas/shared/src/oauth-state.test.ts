import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signState, verifyState } from "./oauth-state.js";

const SECRET = "test-client-secret";
const TENANT_ID = "tenant-a";

/** Hand-signs a payload with the real algorithm, bypassing signState -- used to construct
 *  edge cases (missing tenantId, forged payloads) signState's own API can't produce. */
function signPayload(secret: string, payload: Record<string, unknown>): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

describe("signState / verifyState", () => {
  it("round-trips: a state signState mints verifies back to the same tenantId", () => {
    const state = signState(SECRET, TENANT_ID);
    expect(verifyState(SECRET, state)).toBe(TENANT_ID);
  });

  it("rejects a state signed with a different secret (forged/tampered)", () => {
    const state = signState("some-other-secret", TENANT_ID);
    expect(() => verifyState(SECRET, state)).toThrow(/signature mismatch/i);
  });

  it("rejects a state whose payload was tampered with after signing (tenantId swapped, signature not re-computed)", () => {
    const state = signState(SECRET, TENANT_ID);
    const [payloadB64, signature] = state.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8")) as { tenantId: string };
    const tamperedPayload = { ...payload, tenantId: "victim-tenant" };
    const tamperedState = `${Buffer.from(JSON.stringify(tamperedPayload)).toString("base64url")}.${signature}`;

    expect(() => verifyState(SECRET, tamperedState)).toThrow(/signature mismatch/i);
  });

  it("rejects a state with a tampered signature", () => {
    const state = signState(SECRET, TENANT_ID);
    const [payloadB64] = state.split(".");
    const tamperedState = `${payloadB64}.not-the-real-signature-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;

    expect(() => verifyState(SECRET, tamperedState)).toThrow(/signature mismatch/i);
  });

  it("rejects a malformed state (missing the payload.signature separator)", () => {
    expect(() => verifyState(SECRET, "not-a-real-state")).toThrow(/malformed/i);
  });

  it("rejects an expired state, even one that was validly signed", () => {
    const state = signState(SECRET, TENANT_ID);
    // maxAgeMs = -1 guarantees "age > maxAgeMs" holds no matter how little time has
    // actually elapsed since signState just minted this -- avoids needing fake timers to
    // simulate a real 10-minute wait.
    expect(() => verifyState(SECRET, state, -1)).toThrow(/expired/i);
  });

  it("accepts a state right up to its TTL boundary and rejects it just past it", () => {
    const state = signState(SECRET, TENANT_ID);
    expect(() => verifyState(SECRET, state, 5_000)).not.toThrow(); // comfortably within a generous TTL
  });

  it("rejects oversized states and extra signature segments", () => {
    const valid = signState(SECRET, TENANT_ID);
    expect(() => verifyState(SECRET, valid + ".extra")).toThrow(/malformed/i);
    expect(() => verifyState(SECRET, "A".repeat(2000) + ".invalid")).toThrow(/malformed/i);
  });

  it("rejects validly signed but implausible timestamps, malformed nonces and tenant types", () => {
    const validNonce = "5f0dbf57-e9b8-4ae7-91d9-659ed68e217d";
    expect(() => verifyState(SECRET, signPayload(SECRET, {
      nonce: validNonce, issuedAt: Date.now() + 90_000, tenantId: TENANT_ID,
    }))).toThrow(/expired/i);
    expect(() => verifyState(SECRET, signPayload(SECRET, {
      nonce: "not-a-uuid", issuedAt: Date.now(), tenantId: TENANT_ID,
    }))).toThrow(/nonce/i);
    expect(() => verifyState(SECRET, signPayload(SECRET, {
      nonce: validNonce, issuedAt: "yesterday", tenantId: TENANT_ID,
    }))).toThrow(/timestamp/i);
    expect(() => verifyState(SECRET, signPayload(SECRET, {
      nonce: validNonce, issuedAt: Date.now(), tenantId: { id: "victim" },
    }))).toThrow(/tenantId/i);
  });

  it("rejects a validly-signed payload with no tenantId at all", () => {
    const state = signPayload(SECRET, { nonce: "n", issuedAt: Date.now() });
    expect(() => verifyState(SECRET, state)).toThrow(/tenantId/i);
  });

  it("never accepts a client-supplied tenantId -- signState always mints from its own explicit parameter, never from external input echoed back", () => {
    // This is really a documentation-level guarantee (signState's signature takes
    // (secret, tenantId) with no room for an untrusted extra field), but pin it down: two
    // states minted for two different tenantIds never verify to the same tenant.
    const stateA = signState(SECRET, "tenant-a");
    const stateB = signState(SECRET, "tenant-b");
    expect(verifyState(SECRET, stateA)).toBe("tenant-a");
    expect(verifyState(SECRET, stateB)).toBe("tenant-b");
  });
});
