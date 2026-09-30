import { IMPLEMENTED_CHANNELS, type ChannelAdapter, type ChannelType } from "@ai-ec/core";
import { channelListings, listOffboardingCandidates, markTenantMarketplaceOffboarded, type Database } from "@ai-ec/db";
import {
  deleteOAuthConnectionsForTenant,
  getDb,
  getValidAccessToken,
  listConnectedAccountIds,
  loadImplementedChannelAdapters,
  recordAuditLog,
  recordSyncError,
} from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";

/**
 * Scheduled (EventBridge) worker: the "offboarding" half of a canceled/canceling tenant's
 * lifecycle (see listWorkerEligibleTenants/tenantSyncCapabilities in @ai-ec/db for the
 * other half -- keeping existing listings safely synced until this runs). Delists every
 * still-published channel_listing on both marketplaces, then, once every one of them is
 * confirmed delisted, revokes this platform's own OAuth connections/tokens for that tenant
 * and marks it marketplace-safe -- at which point listWorkerEligibleTenants stops scheduling
 * any further worker for it at all.
 */
export async function handler(): Promise<void> {
  const db = getDb();

  const adapters = await loadImplementedChannelAdapters();

  const candidates = await listOffboardingCandidates(db);
  for (const tenant of candidates) {
    await offboardTenant(db, adapters, tenant.id);
  }
}

/**
 * Runs one tenant's offboarding pass. Never partially revokes OAuth or marks a tenant
 * offboarded while any of its listings might still be live -- a listing that fails to
 * delist (a transient API error, an already-expired token) just leaves this tenant a
 * candidate again on the next scheduled run, so nothing is ever silently abandoned.
 * Idempotent and safe to re-run: a listing already `status: "delisted"` is never
 * re-attempted, and deleteOAuthConnectionsForTenant is a no-op once a connection is
 * already gone.
 */
export async function offboardTenant(
  db: Database,
  adapters: Partial<Record<ChannelType, ChannelAdapter>>,
  tenantId: string,
): Promise<void> {
  const stillPublished = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.status, "published")));

  let allDelisted = true;

  for (const listing of stillPublished) {
    const adapter = adapters[listing.channel as ChannelType];
    if (!adapter || !listing.externalId) {
      allDelisted = false;
      continue;
    }

    try {
      const [accountId] = await listConnectedAccountIds(db, tenantId, listing.channel);
      if (!accountId) {
        // No live OAuth connection left to delist through. This platform can no longer
        // push anything to this listing either way, so it's no longer a risk this
        // platform is creating -- doesn't block offboarding from completing.
        continue;
      }
      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
      await adapter.delistProduct(accessToken, listing.externalId);

      await db
        .update(channelListings)
        .set({ status: "delisted", lastError: null, updatedAt: new Date() })
        .where(eq(channelListings.id, listing.id));

      await recordAuditLog(db, {
        tenantId,
        actor: "system:tenant-offboarding",
        action: "listing_delisted_offboarding",
        entityType: "product",
        entityId: listing.productId,
        after: { channel: listing.channel, externalId: listing.externalId },
      });
    } catch (err) {
      allDelisted = false;
      await recordSyncError(db, {
        tenantId,
        channel: listing.channel,
        productId: listing.productId,
        errorCode: "offboarding_delist_failed",
        errorMessage: (err as Error).message,
      });
    }
  }

  if (!allDelisted) return; // retried on the next scheduled run

  for (const channel of IMPLEMENTED_CHANNELS) {
    await deleteOAuthConnectionsForTenant(db, tenantId, channel);
  }

  await markTenantMarketplaceOffboarded(db, tenantId);
  await recordAuditLog(db, {
    tenantId,
    actor: "system:tenant-offboarding",
    action: "tenant_marketplace_offboarded",
    entityType: "tenant",
    entityId: tenantId,
    after: {},
  });
}
