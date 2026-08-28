import { BaseAdapter } from "@ai-ec/adapter-base";
import { EbayAdapter } from "@ai-ec/adapter-ebay";
import type { ChannelAdapter, SaleEvent } from "@ai-ec/core";
import { enqueue, getAppCredentials, getDb, getQueueUrls, getValidAccessToken, listConnectedAccountIds } from "@ai-ec/lambda-shared";

/**
 * Scheduled (EventBridge) poller: asks each connected channel for orders placed
 * recently and forwards every line item as a "sale happened" event onto the inventory
 * sync queue. The lookback window intentionally overlaps between runs — duplicate
 * events are safe because inventory-sync-worker dedupes on (channel, orderId, sku).
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const since = new Date(Date.now() - 15 * 60 * 1000); // 15 min lookback vs. a 5 min schedule

  const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
  await pollChannel(new BaseAdapter(baseCreds), since, db, queues.inventorySync);

  const ebayCreds = await getAppCredentials<{
    clientId: string;
    clientSecret: string;
    ruName: string;
    merchantLocationKey: string;
  }>("ebay");
  await pollChannel(new EbayAdapter(ebayCreds), since, db, queues.inventorySync);
}

async function pollChannel(
  adapter: ChannelAdapter,
  since: Date,
  db: ReturnType<typeof getDb>,
  queueUrl: string,
): Promise<void> {
  const accountIds = await listConnectedAccountIds(db, adapter.channel);
  for (const accountId of accountIds) {
    const accessToken = await getValidAccessToken(db, adapter, accountId);
    const sales = await adapter.listRecentSales(accessToken, since);
    for (const sale of sales) {
      await enqueueSale(queueUrl, sale);
    }
  }
}

async function enqueueSale(queueUrl: string, sale: SaleEvent): Promise<void> {
  const dedupeId = `${sale.channel}:${sale.externalOrderId}:${sale.externalProductId}`;
  await enqueue(queueUrl, { type: "sale_detected", sale }, dedupeId);
}
