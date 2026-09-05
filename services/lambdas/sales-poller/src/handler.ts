import { BaseAdapter } from "@ai-ec/adapter-base";
import { isChannelIsolated } from "@ai-ec/db";
import {
  createEbayAdapter,
  emitChannelIsolatedMetric,
  getAppCredentials,
  getDb,
  getQueueUrls,
  pollChannelSales,
  recordAuditLog,
  recordSyncError,
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
 * Item A of the third hardening round ("チャネル障害時の隔離モード -- eBay障害中は
 * eBayだけ自動隔離し、BASEは正常運用を継続"). Checks isChannelIsolated() before polling a
 * channel at all, and -- just as important -- never lets one channel's poll failure escape
 * uncaught. Confirmed live: previously an unhandled rejection here aborted the whole Lambda
 * invocation instead of being recorded per-channel, showing up only as an opaque top-level
 * "Invoke Error" that computeSyncConfidence/isChannelIsolated couldn't see at all (they only
 * read sync_errors) -- eBay's OAuth token expiring with no refresh token stored was doing
 * exactly this on every 1-minute cycle. BASE's poll happened to still run because it's
 * called first in handler() above, but that was incidental to call order, never a guarantee.
 */
export async function pollChannelIfHealthy(
  db: ReturnType<typeof getDb>,
  channel: "base" | "ebay",
  poll: () => Promise<void>,
): Promise<void> {
  const isolation = await isChannelIsolated(db, channel);
  if (isolation.isolated) {
    emitChannelIsolatedMetric(channel);
    await recordAuditLog(db, {
      actor: "system:sales-poller",
      action: "channel_isolated_skip",
      entityType: "channel",
      entityId: channel,
      after: { reasons: isolation.reasons },
    });
    return;
  }

  try {
    await poll();
  } catch (err) {
    await recordSyncError(db, {
      channel,
      productId: null,
      errorCode: "sales_poll_failed",
      errorMessage: (err as Error).message,
    });
  }
}
