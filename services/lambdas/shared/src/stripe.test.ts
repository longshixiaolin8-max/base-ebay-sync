import { describe, expect, it } from "vitest";
import { resolvePlanFromPriceId, resolvePlanPriceIds, type StripeAppCredentials } from "./stripe.js";

const baseCreds: StripeAppCredentials = {
  secretKey: "sk_test_123",
  publishableKey: "pk_test_123",
  priceId: "price_standard",
  webhookSigningSecret: "whsec_123",
};

describe("resolvePlanPriceIds", () => {
  it("always includes 'standard' from priceId, even with no priceIds configured", () => {
    expect(resolvePlanPriceIds(baseCreds)).toEqual({ standard: "price_standard" });
  });

  it("merges configured priceIds on top of the always-present standard entry", () => {
    const creds = { ...baseCreds, priceIds: { starter: "price_starter", pro: "price_pro" } };
    expect(resolvePlanPriceIds(creds)).toEqual({
      starter: "price_starter",
      pro: "price_pro",
      standard: "price_standard",
    });
  });

  it("never lets a priceIds['standard'] entry override priceId itself", () => {
    // priceId is documented as standard's one source of truth -- a stray priceIds.standard
    // entry (e.g. a copy/paste mistake while filling in the secret) must never win.
    const creds = { ...baseCreds, priceIds: { standard: "price_wrong" } };
    expect(resolvePlanPriceIds(creds).standard).toBe("price_standard");
  });
});

describe("resolvePlanFromPriceId", () => {
  it("resolves the standard plan from priceId", () => {
    expect(resolvePlanFromPriceId(baseCreds, "price_standard")).toBe("standard");
  });

  it("resolves a configured tier's plan name from its own price id", () => {
    const creds = { ...baseCreds, priceIds: { starter: "price_starter", pro: "price_pro" } };
    expect(resolvePlanFromPriceId(creds, "price_pro")).toBe("pro");
    expect(resolvePlanFromPriceId(creds, "price_starter")).toBe("starter");
  });

  it("falls back to 'standard' for a price id that matches no configured plan", () => {
    // Never silently grants an unintended tier for an unrecognized price -- same safe
    // fallback getPlanLimits() itself uses for an unrecognized plan name.
    expect(resolvePlanFromPriceId(baseCreds, "price_unknown")).toBe("standard");
  });
});
