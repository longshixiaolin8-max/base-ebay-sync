import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import {
  createPendingTenant,
  findTenantByStripeCustomerId,
  getTenantBillingStatus,
  markTenantActive,
  markTenantCanceledWithGrace,
  markTenantPastDue,
} from "./billing.js";

/** Builds a mock DB where the `isStale` pre-check's select sees `lastBillingEventAt`. */
function dbWithLastBillingEventAt(lastBillingEventAt: Date | null, patchSink: { patch?: Record<string, unknown> }): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ lastBillingEventAt }],
        }),
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        patchSink.patch = v;
        return { where: async () => undefined };
      },
    }),
  } as unknown as Database;
}

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
  it("returns the tenant's plan/status/stripeCustomerId/stripeSubscriptionId/name/grace fields", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                plan: "standard",
                status: "active",
                stripeCustomerId: "cus_123",
                stripeSubscriptionId: "sub_456",
                name: "Acme Inc",
                gracePeriodEndsAt: null,
                lastBillingEventAt: null,
              },
            ],
          }),
        }),
      }),
    } as unknown as Database;

    expect(await getTenantBillingStatus(db, "tenant-a")).toEqual({
      plan: "standard",
      status: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
      name: "Acme Inc",
      gracePeriodEndsAt: null,
      lastBillingEventAt: null,
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
  it("sets status to active, stores the Stripe ids, clears grace, and records the event time", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(null, sink);
    const eventCreatedAt = new Date("2026-01-01T00:00:00Z");

    const applied = await markTenantActive(db, "tenant-a", { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_456" }, eventCreatedAt);

    expect(applied).toBe(true);
    expect(sink.patch).toEqual({
      status: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
      gracePeriodEndsAt: null,
      lastBillingEventAt: eventCreatedAt,
    });
  });

  it("does not apply an event older than the tenant's already-applied event (out-of-order guard)", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(new Date("2026-02-01T00:00:00Z"), sink);
    const staleEventCreatedAt = new Date("2026-01-01T00:00:00Z");

    const applied = await markTenantActive(db, "tenant-a", { stripeCustomerId: "cus_123", stripeSubscriptionId: "sub_456" }, staleEventCreatedAt);

    expect(applied).toBe(false);
    expect(sink.patch).toBeUndefined();
  });
});

describe("markTenantPastDue", () => {
  it("sets status to past_due and records the event time", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(null, sink);
    const eventCreatedAt = new Date("2026-01-01T00:00:00Z");

    const applied = await markTenantPastDue(db, "tenant-a", eventCreatedAt);

    expect(applied).toBe(true);
    expect(sink.patch).toEqual({ status: "past_due", lastBillingEventAt: eventCreatedAt });
  });

  it("does not apply a stale event", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(new Date("2026-02-01T00:00:00Z"), sink);

    const applied = await markTenantPastDue(db, "tenant-a", new Date("2026-01-01T00:00:00Z"));

    expect(applied).toBe(false);
    expect(sink.patch).toBeUndefined();
  });
});

describe("markTenantCanceledWithGrace", () => {
  it("sets status to canceled_grace with a grace period ending 30 days after the event, by default", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(null, sink);
    const eventCreatedAt = new Date("2026-01-01T00:00:00Z");

    const result = await markTenantCanceledWithGrace(db, "tenant-a", eventCreatedAt);

    expect(result.applied).toBe(true);
    expect(result.gracePeriodEndsAt).toEqual(new Date("2026-01-31T00:00:00Z"));
    expect(sink.patch).toEqual({
      status: "canceled_grace",
      gracePeriodEndsAt: new Date("2026-01-31T00:00:00Z"),
      lastBillingEventAt: eventCreatedAt,
    });
  });

  it("does not apply a stale event, but still returns the grace period it would have set", async () => {
    const sink: { patch?: Record<string, unknown> } = {};
    const db = dbWithLastBillingEventAt(new Date("2026-02-01T00:00:00Z"), sink);

    const result = await markTenantCanceledWithGrace(db, "tenant-a", new Date("2026-01-01T00:00:00Z"));

    expect(result.applied).toBe(false);
    expect(sink.patch).toBeUndefined();
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
