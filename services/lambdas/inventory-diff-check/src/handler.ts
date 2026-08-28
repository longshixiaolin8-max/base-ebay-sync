import { BaseAdapter } from "@ai-ec/adapter-base";
import { EbayAdapter } from "@ai-ec/adapter-ebay";
import type { ChannelAdapter, ChannelType } from "@ai-ec/core";
import { channelListings, inventoryMaster } from "@ai-ec/db";
import {
  getAppCredentials,
  getDb,
  getValidAccessToken,
  listConnectedAccountIds,
  recordSyncError,
} from "@ai-ec/lambda-shared";
import { eq } from "drizzle-orm";

/**
 * Scheduled (EventBridge) reconciliation job: compares each published channel listing's
 * live quantity against the central inventory_master. Drift is surfaced as a sync_errors
 * row (errorCode "inventory_drift") for a human to review in the admin dashboard — it is
 * intentionally NOT auto-corrected, since silently overwriting either side could itself
 * cause a double-sell if the drift's root cause is a bug rather than an expected delay.
 */
export async function handler(): Promise<void> {
  const db = getDb();

  const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
  const ebayCreds = await getAppCredentials<{
    clientId: string;
    clientSecret: string;
    ruName: string;
    merchantLocationKey: string;
  }>("ebay");
  const adapters: Partial<Record<ChannelType, ChannelAdapter>> = {
    base: new BaseAdapter(baseCreds),
    ebay: new EbayAdapter(ebayCreds),
  };

  const publishedListings = await db.select().from(channelListings).where(eq(channelListings.status, "published"));

  const tokenCache = new Map<ChannelType, string>();

  for (const listing of publishedListings) {
    if (!listing.externalId) continue;
    const adapter = adapters[listing.channel as ChannelType];
    if (!adapter) continue;

    try {
      let accessToken = tokenCache.get(listing.channel as ChannelType);
      if (!accessToken) {
        const [accountId] = await listConnectedAccountIds(db, listing.channel);
        if (!accountId) continue;
        accessToken = await getValidAccessToken(db, adapter, accountId);
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

      if (liveQuantity !== master.quantity) {
        await recordSyncError(db, {
          channel: listing.channel,
          productId: listing.productId,
          errorCode: "inventory_drift",
          errorMessage: `${listing.channel} reports quantity=${liveQuantity} but inventory_master has quantity=${master.quantity}`,
          payload: { externalId: listing.externalId, liveQuantity, masterQuantity: master.quantity },
        });
      }
    } catch (err) {
      await recordSyncError(db, {
        channel: listing.channel,
        productId: listing.productId,
        errorCode: "inventory_diff_check_failed",
        errorMessage: (err as Error).message,
      });
    }
  }
}
