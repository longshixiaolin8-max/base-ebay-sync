import type { ChannelAdapter, SaleEvent } from "@ai-ec/core";
import type { Database } from "@ai-ec/db";
import { enqueue } from "./sqs.js";
import { getValidAccessToken, listConnectedAccountIds } from "./secrets.js";

/**
 * Polls a single channel for orders placed since `since` and forwards every line item
 * as a "sale happened" event onto the inventory sync queue. Shared between the scheduled
 * sales-poller (broad lookback, all channels) and event-triggered pollers (narrow lookback,
 * a single channel reacting to a near-real-time signal like an eBay webhook) so both paths
 * dedupe and enqueue sales identically.
 */
export async function pollChannelSales(
  adapter: ChannelAdapter,
  since: Date,
  db: Database,
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
