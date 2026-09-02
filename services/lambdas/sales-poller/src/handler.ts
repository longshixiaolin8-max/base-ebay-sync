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
 * Neither channel offers a real "item sold" push signal: BASE has no webhook feature at
 * all (confirmed against BASE's own help center), and eBay's Notification API has no
 * direct "item sold" topic (verified live via getTopics) -- the closest signal, LISTING,
 * needs a sell.listing[.read] scope this app's Sandbox keyset doesn't have access to yet
 * (ebay-webhook is built and deployed for when that scope becomes available, but is
 * currently dormant/unregistered). Until then, this 1-minute schedule is the practical
 * substitute for real-time sync on both channels.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const since = new Date(Date.now() - 5 * 60 * 1000); // 5 min lookback vs. a 1 min schedule

  const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
  await pollChannelSales(new BaseAdapter(baseCreds), since, db, queues.inventorySync);

  const ebayCreds = await getAppCredentials<EbayAppCredentials>("ebay");
  await pollChannelSales(createEbayAdapter(ebayCreds), since, db, queues.inventorySync);
}
