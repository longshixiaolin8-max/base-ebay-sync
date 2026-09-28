import { and, inArray, isNull, ne, or } from "drizzle-orm";
import type { TenantStatus } from "./billing.js";
import type { Database } from "./client.js";
import { tenants } from "./schema.js";

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
