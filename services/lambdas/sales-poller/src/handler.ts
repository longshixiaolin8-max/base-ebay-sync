import { BaseAdapter } from "@ai-ec/adapter-base";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  getQueueUrls,
  pollChannelSales,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";

/**
 * Scheduled (EventBridge) poller: asks each connected channel for orders placed
 * recently and forwards every line item as a "sale happened" event onto the inventory
 * sync queue. The lookback window intentionally overlaps between runs — duplicate
 * events are safe because inventory-sync-worker dedupes on (channel, orderId, sku).
 *
 * eBay's Notification API has no direct "item sold" topic (verified against eBay's live
 * getTopics response) -- ebay-webhook triggers a narrower, faster version of this same
 * poll when eBay's LISTING topic signals a quantity change, but this broad scheduled poll
 * stays as the authoritative fallback for both channels.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const since = new Date(Date.now() - 15 * 60 * 1000); // 15 min lookback vs. a 5 min schedule

  const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
  await pollChannelSales(new BaseAdapter(baseCreds), since, db, queues.inventorySync);

  const ebayCreds = await getAppCredentials<EbayAppCredentials>("ebay");
  await pollChannelSales(createEbayAdapter(ebayCreds), since, db, queues.inventorySync);
}
