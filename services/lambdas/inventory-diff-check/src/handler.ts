import type { ChannelAdapter, ChannelType } from "@ai-ec/core";
import { calculateChannelAvailableQuantity, channelListings, inventoryMaster, listWorkerEligibleTenants, productMaster } from "@ai-ec/db";
import { getDb, getValidAccessToken, listConnectedAccountIds, loadImplementedChannelAdapters, recordSyncError } from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";

/**
 * Scheduled (EventBridge) reconciliation job: compares each published channel listing's
 * live quantity against the central inventory_master. Drift is surfaced as a sync_errors
 * row (errorCode "inventory_drift") for a human to review in the admin dashboard — it is
 * intentionally NOT auto-corrected, since silently overwriting either side could itself
 * cause a double-sell if the drift's root cause is a bug rather than an expected delay.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const tenants = await listWorkerEligibleTenants(db);

  const adapters = await loadImplementedChannelAdapters();

  for (const tenant of tenants) {
    await checkTenant(db, tenant.id, adapters);
  }
}

export async function checkTenant(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  adapters: Partial<Record<ChannelType, ChannelAdapter>>,
): Promise<void> {
  const publishedListings = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.status, "published")));

  const tokenCache = new Map<ChannelType, string>();

  for (const listing of publishedListings) {
    if (!listing.externalId) continue;
    const adapter = adapters[listing.channel as ChannelType];
    if (!adapter) continue;

    try {
      let accessToken = tokenCache.get(listing.channel as ChannelType);
      if (!accessToken) {
        const [accountId] = await listConnectedAccountIds(db, tenantId, listing.channel);
        if (!accountId) continue;
        accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
        tokenCache.set(listing.channel as ChannelType, accessToken);
      }

      const liveQuantity = await adapter.getInventory(accessToken, listing.externalId);
      if (liveQuantity === null) continue;

      const [master] = await db
        .select()
        .from(inventoryMaster)
        .where(eq(inventoryMaster.productId, listing.productId))
        .limit(1);
      if (!master) continue;

      const [product] = await db
        .select()
        .from(productMaster)
        .where(eq(productMaster.id, listing.productId))
        .limit(1);
      if (!product) continue;

      // eBay (or any secondary channel) deliberately publishes central quantity minus the
      // safety stock buffer, not the raw central quantity -- comparing liveQuantity straight
      // against master.quantity flagged every buffered secondary-channel listing as drifted
      // even when it was exactly the intended, correctly-synced value. The source channel
      // itself has no buffer withheld (calculateChannelAvailableQuantity returns the true
      // quantity unbuffered when channel === sourceChannel), matching what
      // ebay-sync-worker/inventory-sync-worker actually push to each channel.
      const expectedQuantity = calculateChannelAvailableQuantity(
        master.quantity,
        master.safetyStockBuffer,
        listing.channel,
        product.sourceChannel,
      );

      if (liveQuantity !== expectedQuantity) {
        await recordSyncError(db, {
          tenantId,
          channel: listing.channel,
          productId: listing.productId,
          errorCode: "inventory_drift",
          errorMessage: `${listing.channel} reports quantity=${liveQuantity} but expected ${expectedQuantity} (central=${master.quantity}, buffer=${master.safetyStockBuffer})`,
          payload: {
            liveQuantity,
            expectedQuantity,
            centralQuantity: master.quantity,
            safetyStockBuffer: master.safetyStockBuffer,
            sourceChannel: product.sourceChannel,
            channel: listing.channel,
            externalId: listing.externalId,
          },
        });
      }
    } catch (err) {
      await recordSyncError(db, {
        tenantId,
        channel: listing.channel,
        productId: listing.productId,
        errorCode: "inventory_diff_check_failed",
        errorMessage: (err as Error).message,
      });
    }
  }
}
