import { IMPLEMENTED_CHANNELS } from "@ai-ec/core";
import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { TenantStatus } from "./billing.js";
import { isChannelIsolated } from "./channel-isolation.js";
import type { Database } from "./client.js";
import { channelListings, syncErrors, tenants } from "./schema.js";

export type NotificationPreferenceKey = "inventoryDiffAlert" | "aiDraftCompleted" | "billingNotice" | "oauthExpiryNotice" | "importantNotice";
export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

/** Every toggle defaults to on, matching 請求・設定 > 通知設定's own design -- a JSONB
 *  column's own DB-level "default" can't express per-key defaults cleanly, so this is applied
 *  in code, at every place that reads notificationPreferences (see resolveNotificationPreferences
 *  below), not the schema. Previously duplicated as an inline object in admin-api's handler.ts;
 *  centralized here once stripe-webhook needed the exact same defaults for real email sends. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  inventoryDiffAlert: true,
  aiDraftCompleted: true,
  billingNotice: true,
  oauthExpiryNotice: true,
  importantNotice: true,
};

/** Merges a tenant's stored (possibly partial, possibly null) preferences over the defaults
 *  above -- the one place "is notification X actually on for this tenant" gets decided. */
export function resolveNotificationPreferences(stored: Partial<NotificationPreferences> | null | undefined): NotificationPreferences {
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(stored ?? {}) };
}

export interface TenantContact {
  name: string;
  contactEmail: string | null;
  notificationPreferences: NotificationPreferences;
}

/** Small, focused query for callers (stripe-webhook's billing-notice email, in particular)
 *  that only need "who do we email, and do they want this kind of notification" -- not the
 *  full getTenantBillingStatus row. */
export async function getTenantContact(db: Database, tenantId: string): Promise<TenantContact | undefined> {
  const [row] = await db
    .select({ name: tenants.name, contactEmail: tenants.contactEmail, notificationPreferences: tenants.notificationPreferences })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) return undefined;
  return { name: row.name, contactEmail: row.contactEmail, notificationPreferences: resolveNotificationPreferences(row.notificationPreferences) };
}

/**
 * The one real business this platform served before multi-tenancy existed. Fixed rather
 * than looked up, so the migration that backfills every table's tenant_id column and every
 * environment built from scratch can reference the exact same row without a lookup.
 */
export const BOOTSTRAP_TENANT_ID = "00000000-0000-0000-0000-000000000001";

export interface WorkerEligibleTenant {
  id: string;
  status: TenantStatus;
  marketplaceOffboardedAt: Date | null;
}

export interface TenantSyncCapabilities {
  /** Existing (already-published) channel_listings must keep having their inventory
   *  reconciled against the source-of-truth channel for as long as anything from this
   *  tenant could still be live and sellable on a marketplace -- an oversell doesn't care
   *  whether the tenant's subscription happens to be current. */
  syncExistingInventory: boolean;
  /** New products may be pulled in from BASE's catalog and queued for AI generation / a
   *  first-time eBay publish. Reserved for tenants in good standing -- a tenant that isn't
   *  currently paying (or has stopped) must not have this platform keep growing its footprint
   *  on either marketplace on its behalf. */
  onboardNewProducts: boolean;
}

/**
 * The tenant lifecycle this platform actually needs, one level more detailed than the raw
 * billing `status` column: what's safe to keep doing for a tenant depends not just on
 * whether it's currently paying, but on whether it might still have something live and
 * sellable on a marketplace that this platform put there.
 *
 *   active         -> normal sync, including onboarding new products.
 *   past_due       -> existing listings keep syncing (a lapsed card must never turn into an
 *                      oversold listing), but nothing new is onboarded.
 *   canceled_grace -> same as past_due: existing listings keep syncing while
 *                      tenant-offboarding works through delisting them; admin access itself
 *                      is separately restricted to read-only (see admin-api's billing gate).
 *   canceled       -> existing listings keep syncing ONLY until tenant-offboarding has
 *                      actually confirmed marketplaceOffboardedAt -- stopping any earlier
 *                      would abandon a still-live listing with nothing left keeping its
 *                      inventory in sync. Once offboarded, no capability remains.
 *   pending_payment-> never had a paid subscription; nothing to protect from overselling yet.
 */
export function tenantSyncCapabilities(tenant: { status: TenantStatus; marketplaceOffboardedAt: Date | null }): TenantSyncCapabilities {
  switch (tenant.status) {
    case "active":
      return { syncExistingInventory: true, onboardNewProducts: true };
    case "past_due":
    case "canceled_grace":
      return { syncExistingInventory: true, onboardNewProducts: false };
    case "canceled":
      return { syncExistingInventory: tenant.marketplaceOffboardedAt === null, onboardNewProducts: false };
    case "pending_payment":
      return { syncExistingInventory: false, onboardNewProducts: false };
  }
}

/**
 * Every tenant a scheduled worker (product-fetch, sales-poller, inventory-diff-check) might
 * still need to do *something* for -- deliberately broader than billing-"active", and
 * deliberately not named that: a past_due or canceled_grace tenant still has real, live
 * marketplace listings that must keep syncing to avoid an oversell, and even a canceled
 * tenant stays in scope until tenant-offboarding confirms its marketplace presence is safely
 * wound down. Callers use tenantSyncCapabilities(tenant) on each returned row to decide
 * exactly what they're still allowed to do -- this list is deliberately permissive, not a
 * stand-in for that per-action gating.
 *
 * Excludes only pending_payment (never had a paid subscription) and a canceled tenant
 * tenant-offboarding has already confirmed fully wound down -- the two states with nothing
 * left for any worker to safely or usefully do.
 */
export async function listWorkerEligibleTenants(db: Database): Promise<WorkerEligibleTenant[]> {
  const rows = await db
    .select({ id: tenants.id, status: tenants.status, marketplaceOffboardedAt: tenants.marketplaceOffboardedAt })
    .from(tenants)
    .where(and(ne(tenants.status, "pending_payment"), or(ne(tenants.status, "canceled"), isNull(tenants.marketplaceOffboardedAt))));
  return rows as WorkerEligibleTenant[];
}

/**
 * Tenants tenant-offboarding itself is responsible for: canceled or in their cancellation
 * grace period, and not yet confirmed marketplace-safe. Distinct from
 * listWorkerEligibleTenants -- a past_due tenant belongs in that list (its existing listings
 * still need routine sync) but is never an offboarding candidate, since past_due doesn't
 * mean the tenant is actually leaving.
 */
export async function listOffboardingCandidates(db: Database): Promise<Array<{ id: string }>> {
  return db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(inArray(tenants.status, ["canceled_grace", "canceled"]), isNull(tenants.marketplaceOffboardedAt)));
}

export interface TenantOpsSummary {
  id: string;
  name: string;
  plan: string;
  status: TenantStatus;
  contactEmail: string | null;
  /** Unresolved sync_errors in the last 24h -- the operator dashboard's main "is this
   *  customer currently having a bad time" signal. */
  unresolvedErrorCount24h: number;
  /** Channels isChannelIsolated currently reports as isolated for this tenant -- the same
   *  stateless, window-based check sales-poller/ebay-sync-worker already gate on. */
  isolatedChannels: string[];
  lastActivityAt: string | null;
}

/**
 * Cross-tenant health rollup for the platform operator's own "/admin/ops" dashboard --
 * every other function in this file is deliberately scoped to a single tenantId; this is the
 * one intentional exception, since "every tenant's health at a glance" has no meaningful
 * single-tenant version to begin with. Access control lives at the API layer (admin-api's
 * requireOperator()), not here -- this function trusts its caller completely, same as
 * listWorkerEligibleTenants above already does for the scheduled workers that call it.
 */
export async function listTenantsOpsSummary(db: Database): Promise<TenantOpsSummary[]> {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name, plan: tenants.plan, status: tenants.status, contactEmail: tenants.contactEmail })
    .from(tenants)
    .orderBy(tenants.name);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  return Promise.all(
    rows.map(async (tenant) => {
      const [unresolvedErrors, isolationChecks, latestListing, latestError] = await Promise.all([
        db
          .select({ id: syncErrors.id })
          .from(syncErrors)
          .where(and(eq(syncErrors.tenantId, tenant.id), eq(syncErrors.resolved, false), gte(syncErrors.createdAt, since24h))),
        Promise.all(IMPLEMENTED_CHANNELS.map((channel) => isChannelIsolated(db, tenant.id, channel))),
        db
          .select({ lastSyncedAt: channelListings.lastSyncedAt })
          .from(channelListings)
          .where(and(eq(channelListings.tenantId, tenant.id), isNotNull(channelListings.lastSyncedAt)))
          .orderBy(desc(channelListings.lastSyncedAt))
          .limit(1),
        db
          .select({ createdAt: syncErrors.createdAt })
          .from(syncErrors)
          .where(eq(syncErrors.tenantId, tenant.id))
          .orderBy(desc(syncErrors.createdAt))
          .limit(1),
      ]);

      const candidates = [latestListing[0]?.lastSyncedAt, latestError[0]?.createdAt].filter((d): d is Date => d != null);
      const lastActivityAt = candidates.length ? new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString() : null;

      return {
        id: tenant.id,
        name: tenant.name,
        plan: tenant.plan,
        status: tenant.status as TenantStatus,
        contactEmail: tenant.contactEmail,
        unresolvedErrorCount24h: unresolvedErrors.length,
        isolatedChannels: isolationChecks.filter((c) => c.isolated).map((c) => c.channel),
        lastActivityAt,
      };
    }),
  );
}
