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
  tenantId: string,
  adapter: ChannelAdapter,
  since: Date,
  db: Database,
  queueUrl: string,
): Promise<void> {
  const accountIds = await listConnectedAccountIds(db, tenantId, adapter.channel);
  for (const accountId of accountIds) {
    const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);
    const sales = await adapter.listRecentSales(accessToken, since);
    for (const sale of sales) {
      await enqueueSale(queueUrl, tenantId, sale);
    }
  }
}

async function enqueueSale(queueUrl: string, tenantId: string, sale: SaleEvent): Promise<void> {
  // tenantId prefixed for the same reason buildIdempotencyKey requires it: channel-native
  // order/item ids are only unique within one tenant's own connected account, so two
  // independent tenants could otherwise collide on the same FIFO dedupe id.
  const dedupeId = `${tenantId}:${sale.channel}:${sale.externalOrderId}:${sale.externalProductId}`;
  await enqueue(queueUrl, { type: "sale_detected", tenantId, sale }, dedupeId);
}
