import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, resolveNotificationPreferences, tenantSyncCapabilities } from "./tenants.js";

describe("tenantSyncCapabilities", () => {
  it("active: normal sync, including onboarding new products", () => {
    expect(tenantSyncCapabilities({ status: "active", marketplaceOffboardedAt: null })).toEqual({
      syncExistingInventory: true,
      onboardNewProducts: true,
    });
  });

  it("past_due: existing listings keep syncing (avoid an oversell), but no new onboarding", () => {
    expect(tenantSyncCapabilities({ status: "past_due", marketplaceOffboardedAt: null })).toEqual({
      syncExistingInventory: true,
      onboardNewProducts: false,
    });
  });

  it("canceled_grace: same as past_due -- existing listings sync while offboarding works through delisting them", () => {
    expect(tenantSyncCapabilities({ status: "canceled_grace", marketplaceOffboardedAt: null })).toEqual({
      syncExistingInventory: true,
      onboardNewProducts: false,
    });
  });

  it("canceled, not yet offboarded: existing listings still sync -- nothing may be abandoned mid-cancellation", () => {
    expect(tenantSyncCapabilities({ status: "canceled", marketplaceOffboardedAt: null })).toEqual({
      syncExistingInventory: true,
      onboardNewProducts: false,
    });
  });

  it("canceled, offboarding confirmed: no capability remains -- nothing left for any worker to do", () => {
    expect(tenantSyncCapabilities({ status: "canceled", marketplaceOffboardedAt: new Date("2026-01-01T00:00:00Z") })).toEqual({
      syncExistingInventory: false,
      onboardNewProducts: false,
    });
  });

  it("pending_payment: never had a paid subscription -- nothing to protect from overselling, and no publishing", () => {
    expect(tenantSyncCapabilities({ status: "pending_payment", marketplaceOffboardedAt: null })).toEqual({
      syncExistingInventory: false,
      onboardNewProducts: false,
    });
  });

  it("onboardNewProducts is false for every non-active status, regardless of marketplaceOffboardedAt", () => {
    const nonActiveStatuses = ["past_due", "canceled_grace", "canceled", "pending_payment"] as const;
    for (const status of nonActiveStatuses) {
      expect(tenantSyncCapabilities({ status, marketplaceOffboardedAt: null }).onboardNewProducts).toBe(false);
      expect(tenantSyncCapabilities({ status, marketplaceOffboardedAt: new Date() }).onboardNewProducts).toBe(false);
    }
  });
});

describe("resolveNotificationPreferences", () => {
  it("returns every default (all true) when nothing is stored", () => {
    expect(resolveNotificationPreferences(null)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(resolveNotificationPreferences(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
  });

  it("merges a partial stored value over the defaults, leaving unset keys at their default", () => {
    expect(resolveNotificationPreferences({ billingNotice: false })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      billingNotice: false,
    });
  });
});
