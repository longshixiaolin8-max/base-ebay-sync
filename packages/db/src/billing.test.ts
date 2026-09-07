import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  createPendingTenant,
  findTenantByStripeCustomerId,
  getTenantBillingStatus,
  markTenantActive,
  markTenantInactive,
} from "./billing.js";

describe("createPendingTenant", () => {
  it("inserts a new tenant row with status pending_payment and returns its id", async () => {
    let inserted: Record<string, unknown> | undefined;
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted = v;
          return { returning: async () => [{ id: "new-tenant-id" }] };
        },
      }),
    } as unknown as Database;

    const result = await createPendingTenant(db, "Acme Inc");

    expect(result).toEqual({ id: "new-tenant-id" });
    expect(inserted).toEqual({ name: "Acme Inc", status: "pending_payment" });
  });
});

describe("getTenantBillingStatus", () => {
  it("returns the tenant's plan/status/stripeCustomerId", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ plan: "standard", status: "active", stripeCustomerId: "cus_123" }] }),
        }),
      }),
    } as unknown as Database;

    expect(await getTenantBillingStatus(db, "tenant-a")).toEqual({
      plan: "standard",
      status: "active",
      stripeCustomerId: "cus_123",
    });
  });

  it("returns undefined when the tenant does not exist", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Database;

    expect(await getTenantBillingStatus(db, "missing-tenant")).toBeUndefined();
  });
});

describe("markTenantActive", () => {
  it("sets status to active and stores the Stripe customer/subscription ids", async () => {
    let patch: Record<string, unknown> | undefined;
    const db = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          patch = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await markTenantActive(db, "tenant-a", { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_456" });

    expect(patch).toEqual({ status: "active", stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_456" });
  });
});

describe("markTenantInactive", () => {
  it("sets the given inactive status", async () => {
    let patch: Record<string, unknown> | undefined;
    const db = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          patch = v;
          return { where: async () => undefined };
        },
      }),
    } as unknown as Database;

    await markTenantInactive(db, "tenant-a", "past_due");

    expect(patch).toEqual({ status: "past_due" });
  });
});

describe("findTenantByStripeCustomerId", () => {
  it("returns the matching tenant id", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: "tenant-a" }] }) }) }),
    } as unknown as Database;

    expect(await findTenantByStripeCustomerId(db, "cus_123")).toEqual({ id: "tenant-a" });
  });

  it("returns undefined when no tenant has this Stripe customer id", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as unknown as Database;

    expect(await findTenantByStripeCustomerId(db, "cus_unknown")).toBeUndefined();
  });
});
