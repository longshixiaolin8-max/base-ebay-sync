import { BaseAdapter } from "@ai-ec/adapter-base";
import { isChannelIsolated, listWorkerEligibleTenants } from "@ai-ec/db";
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

// EventBridge rate() expressions can't go below 1 minute, so that's the schedule
// (SalesPollerSchedule in infra/lib/lambda-stack.ts) and the real polling interval.
//
// This function used to loop 3-4 times per invocation (sleeping ~15s between passes) to
// approximate a sub-minute effective interval without new infra. Confirmed live: Lambda
// bills for wall-clock time including those sleeps, so each invocation ran ~45-50s instead
// of the few seconds a single pass takes -- about a 10x cost multiplier for cutting the
// worst-case "item sells on one channel, other channel's stock not yet zeroed" window from
// ~60s to ~15s, which blew through the AWS Lambda free tier's 400,000 GB-second/month
// allowance in the first week of the month (SalesPoller alone was 97% of all Lambda usage).
// A single pass per invocation, relying on the 1-minute EventBridge schedule alone for
// cadence, is the right tradeoff: double-sell risk within a <75s window is already rare
// regardless of 15s vs 60s granularity, and the cost difference is not.
const LOOKBACK_MS = 5 * 60 * 1000; // 5 min lookback vs. a 1-minute poll interval

/**
 * Scheduled (EventBridge) poller: asks each connected channel for orders placed
 * recently and forwards every line item as a "sale happened" event onto the inventory
 * sync queue. The lookback window intentionally overlaps between runs — duplicate events
 * are safe because inventory-sync-worker dedupes on (channel, orderId, sku).
 *
 * Neither channel offers a real "item sold" push signal: BASE has no webhook feature at
 * all (confirmed against BASE's own help center), and eBay's Notification API has no
 * direct "item sold" topic (verified live via getTopics) -- the closest signal, LISTING,
 * needs a sell.listing[.read] scope this app's Sandbox keyset doesn't have access to yet
 * (ebay-webhook is built and deployed for when that scope becomes available, but is
 * currently dormant/unregistered). Until then, this poll is the practical substitute for
 * real-time sync on both channels.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const since = new Date(Date.now() - LOOKBACK_MS);
  const tenants = await listWorkerEligibleTenants(db);

  for (const tenant of tenants) {
    await pollChannelIfHealthy(db, tenant.id, "base", async () => {
      const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
      await pollChannelSales(tenant.id, new BaseAdapter(baseCreds), since, db, queues.inventorySync);
    });

    await pollChannelIfHealthy(db, tenant.id, "ebay", async () => {
      const ebayCreds = await getAppCredentials<EbayAppCredentials>("ebay");
      await pollChannelSales(tenant.id, createEbayAdapter(ebayCreds), since, db, queues.inventorySync);
    });
  }
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
  tenantId: string,
  channel: "base" | "ebay",
  poll: () => Promise<void>,
): Promise<void> {
  const isolation = await isChannelIsolated(db, tenantId, channel);
  if (isolation.isolated) {
    emitChannelIsolatedMetric(channel);
    await recordAuditLog(db, {
      tenantId,
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
      tenantId,
      channel,
      productId: null,
      errorCode: "sales_poll_failed",
      errorMessage: (err as Error).message,
    });
  }
}
