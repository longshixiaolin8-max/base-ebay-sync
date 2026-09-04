import { BaseAdapter } from "@ai-ec/adapter-base";
import { shouldThrottleChannel } from "@ai-ec/db";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  getQueueUrls,
  pollChannelSales,
  recordAuditLog,
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

  await pollChannelIfHealthy(db, "base", async () => {
    const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
    await pollChannelSales(new BaseAdapter(baseCreds), since, db, queues.inventorySync);
  });

  await pollChannelIfHealthy(db, "ebay", async () => {
    const ebayCreds = await getAppCredentials<EbayAppCredentials>("ebay");
    await pollChannelSales(createEbayAdapter(ebayCreds), since, db, queues.inventorySync);
  });
}

/**
 * Item #4 of the second hardening round ("チャネル別レート制御"). This poller covers both
 * channels in one fixed-schedule invocation, so there is no single EventBridge rule to
 * slow down for just one of them (and CDK owns the rule either way — see product-fetch for
 * the same reasoning). Skipping just this channel's half of the cycle when it's recently
 * been rate-limited or erroring a lot reduces its *effective* polling frequency without
 * holding up the other, healthy channel.
 */
export async function pollChannelIfHealthy(
  db: ReturnType<typeof getDb>,
  channel: "base" | "ebay",
  poll: () => Promise<void>,
): Promise<void> {
  const throttle = await shouldThrottleChannel(db, channel);
  if (throttle.throttle) {
    await recordAuditLog(db, {
      actor: "system:sales-poller",
      action: "poll_skipped_due_to_throttle",
      entityType: "channel",
      entityId: channel,
      after: { reasons: throttle.reasons },
    });
    return;
  }
  await poll();
}
