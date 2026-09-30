import { buildIdempotencyKey, otherChannels, withIdempotency, type ChannelAdapter, type ChannelType, type SaleEvent } from "@ai-ec/core";
import {
  applySaleWithOutbox,
  calculateChannelAvailableQuantity,
  channelListings,
  inventoryMaster,
  isChannelIsolated,
  productMaster,
  syncJobs,
  upsertOrderReceived,
  type ApplySaleWithOutboxResult,
} from "@ai-ec/db";
import {
  getDb,
  getIdempotencyStore,
  getValidAccessToken,
  listConnectedAccountIds,
  loadImplementedChannelAdapters,
  recordAuditLog,
  recordSyncError,
} from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface SaleDetectedMessage {
  type: "sale_detected";
  tenantId: string;
  sale: SaleEvent;
}

/**
 * The sale-application transaction below (applySaleWithOutbox, in @ai-ec/db) and this file's
 * own dispatchPhaseB are still built around exactly one "other channel" per sale: one outbox
 * sync_jobs row, one idempotency key with no target-channel component, one setInventory call.
 * Deriving "the other channel" from the N-safe otherChannels() core helper -- instead of the
 * old `channel === "base" ? "ebay" : "base"` ternary -- means a 3rd channel added to
 * IMPLEMENTED_CHANNELS fails loudly right here instead of silently syncing to only one of two
 * other channels (or the wrong one). See docs/adding-a-channel.md for what real N-channel
 * fan-out here would require (a per-target-channel idempotency key and one outbox job per
 * other channel, not one) before lifting this guard.
 */
function singleOtherChannel(channel: ChannelType): ChannelType {
  const others = otherChannels(channel);
  if (others.length !== 1) {
    throw new Error(
      `inventory-sync-worker's sale pipeline only supports exactly 2 implemented channels today; otherChannels(${channel}) returned [${others.join(", ")}]. See docs/adding-a-channel.md before adding a 3rd channel to IMPLEMENTED_CHANNELS.`,
    );
  }
  return others[0]!;
}

/**
 * Marks a failure that already happened *inside* dispatchPhaseB, which has already recorded
 * its own sync_error (with a jobId the admin retry UI can act on) and updated the sync_jobs
 * row before rethrowing to get this SQS message retried. Rethrown so the handler's own
 * batchItemFailures bookkeeping still applies, but distinctly named so the outer catch (see
 * handler() below) doesn't record a second, jobId-less duplicate of the same error --
 * mirrors how IdempotencyInProgressError is already special-cased there.
 */
class PhaseBDispatchError extends Error {
  constructor(cause: Error) {
    super(cause.message);
    this.name = "PhaseBDispatchError";
  }
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();

  const adapters = await loadImplementedChannelAdapters();

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SaleDetectedMessage;
    const { tenantId, sale } = message;
    const idempotencyStore = getIdempotencyStore(tenantId);

    try {
      // Scoping this lookup by tenantId (not just channel+externalId) is load-bearing, not
      // defense-in-depth: BASE/eBay item ids are only unique within one seller's own account,
      // so without tenantId here a second tenant's sale could resolve to -- and decrement --
      // the wrong tenant's inventory.
      const [listing] = await db
        .select()
        .from(channelListings)
        .where(
          and(
            eq(channelListings.tenantId, tenantId),
            eq(channelListings.channel, sale.channel),
            eq(channelListings.externalId, sale.externalProductId),
          ),
        )
        .limit(1);
      if (!listing) {
        throw new Error(
          `No channel_listings row maps ${sale.channel}:${sale.externalProductId} to a product — cannot apply sale`,
        );
      }

      // Phase A: the inventory decrement, its ledger entry, order bookkeeping, and (atomically
      // with the decrement, inside applySaleWithOutbox's own transaction) an outbox row
      // recording that the other channel still needs its quantity pushed. withIdempotency
      // wraps ONLY this -- it runs at most once per real sale event, full stop, regardless of
      // whether Phase B below ever succeeds. This is the actual fix for the double-decrement
      // bug: previously Phase B's own failure (a flaky external API call) made the *whole*
      // guarded closure throw, which made withIdempotency mark the key "failed" -- and a
      // failed key is exactly the one status this store's tryClaim will re-claim on the next
      // SQS redelivery, replaying the decrement a second time for the same real-world sale.
      const key = buildIdempotencyKey(tenantId, ["sale", sale.channel, sale.externalOrderId, sale.externalProductId]);
      const phaseA = await withIdempotency(idempotencyStore, key, () => runPhaseA(db, tenantId, listing.productId, sale));

      // Phase B: dispatch the outbox row, if any. Deliberately outside withIdempotency --
      // this must be free to run again on every redelivery (its own failure here never
      // re-triggers Phase A above, cached or not) until it succeeds. Naturally idempotent:
      // it recomputes the live quantity fresh each time rather than trusting a value computed
      // back whenever Phase A actually ran, so pushing the same already-correct number to
      // BASE/eBay twice is harmless.
      await dispatchPhaseB(db, tenantId, adapters, listing.productId, sale, phaseA);
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError" && error.name !== "PhaseBDispatchError") {
        await recordSyncError(db, {
          tenantId,
          channel: sale.channel,
          productId: null,
          errorCode: "inventory_sync_failed",
          errorMessage: error.message,
          payload: { sale, messageId: record.messageId },
        });
      }
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};

/**
 * Phase A -- see handler()'s own comment on why withIdempotency wraps exactly this and
 * nothing more. Order bookkeeping (upsertOrderReceived) is included here, not because it
 * needs the same hard atomicity as the inventory decrement (it's already idempotent via its
 * own onConflictDoNothing on (channel, externalOrderId, productId)), but so it's attempted
 * exactly once per real sale event rather than redundantly on every Phase B retry. Its own
 * failure is deliberately swallowed here (never re-thrown) -- a bookkeeping miss must never
 * block or fail the sale itself, matching this platform's existing stance verified by this
 * file's own test suite.
 */
export async function runPhaseA(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  productId: string,
  sale: SaleEvent,
): Promise<ApplySaleWithOutboxResult> {
  const outbox = await applySaleWithOutbox(db, tenantId, productId, sale.quantitySold, {
    channel: sale.channel,
    sequenceAt: sale.occurredAt,
    externalEventId: sale.externalOrderId,
    otherChannel: singleOtherChannel(sale.channel),
  });

  // Item #1 of the commercial-features round ("正式なOrderモデルを追加"). A bookkeeping
  // record alongside applySaleWithOutbox above, never a replacement for it. Neither channel's
  // adapter currently parses a real sale price out of its orders API response (see
  // listRecentSales in @ai-ec/adapter-base / @ai-ec/adapter-ebay) -- salePriceJpy/
  // salePriceUsdCents are left null here rather than guessed, until that's built and verified
  // against a real order. Recorded even when alreadyZero: the buyer really paid on this
  // channel, so it belongs in this app's order history regardless of what inventory showed.
  try {
    const [productForOrder] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
    await upsertOrderReceived(db, {
      tenantId,
      productId,
      channel: sale.channel,
      externalOrderId: sale.externalOrderId,
      quantity: sale.quantitySold,
      placedAt: sale.occurredAt,
      costJpy: productForOrder?.costJpy ?? null,
      salePriceJpy: sale.salePriceJpy ?? null,
      salePriceUsdCents: sale.salePriceUsdCents ?? null,
    });
  } catch (err) {
    await recordSyncError(db, {
      tenantId,
      channel: sale.channel,
      productId,
      errorCode: "order_record_failed",
      errorMessage: (err as Error).message,
      payload: { externalOrderId: sale.externalOrderId },
    });
  }

  return outbox;
}

/**
 * Phase B: dispatch the outbox row applySaleWithOutbox left behind (if any) by actually
 * pushing the freshly-reduced quantity to the other channel. Re-reads sync_jobs' own status
 * first and skips if another (concurrent or already-succeeded) attempt already completed it
 * -- SQS's at-least-once delivery means this can legitimately run more than once for the
 * same message.
 */
export async function dispatchPhaseB(
  db: ReturnType<typeof getDb>,
  tenantId: string,
  adapters: Partial<Record<ChannelType, ChannelAdapter>>,
  productId: string,
  sale: SaleEvent,
  phaseA: ApplySaleWithOutboxResult,
): Promise<void> {
  if (phaseA.sale.alreadyZero) {
    // Another event already drove this to zero first — the double-sell guard stops a second
    // decrement, but the order recorded in Phase A is a real, already-paid sale that this
    // product can't actually fulfill. Nothing left to zero out (both channels already read
    // 0), so the only useful action left is making sure a human notices fast.
    await recordSyncError(db, {
      tenantId,
      channel: sale.channel,
      productId,
      errorCode: "possible_double_sale",
      errorMessage: `${sale.channel} order ${sale.externalOrderId} arrived after this product's stock had already reached zero`,
      payload: { externalOrderId: sale.externalOrderId, quantitySold: sale.quantitySold, occurredAt: sale.occurredAt },
    });
    return;
  }

  if (!phaseA.outboxJobId) return; // no other channel published — nothing to dispatch

  const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, phaseA.outboxJobId)).limit(1);
  if (!job || job.status === "completed") return; // already dispatched by a concurrent/earlier attempt

  const otherChannel = singleOtherChannel(sale.channel);
  const [otherListing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, otherChannel)))
    .limit(1);
  if (otherListing?.status !== "published" || !otherListing.externalId) return;

  try {
    // Item A of the third hardening round ("チャネル障害時の隔離モード"). This is exactly
    // the scenario a plain "is an account connected?" check can't catch: eBay's
    // oauth_connections row can be present (accountId found) while its stored access token
    // is expired with no refresh token to fall back on -- confirmed live, that failure
    // happens down in getValidAccessToken below, past the connected-account check. Catching
    // it here instead, before spending an attempt on a call already known likely to fail
    // the same way, and treating it as a known, tracked condition rather than a fresh
    // failure to throw and retry-spam on.
    const isolation = await isChannelIsolated(db, tenantId, otherChannel);
    if (isolation.isolated) {
      await recordAuditLog(db, {
        tenantId,
        actor: "system:inventory-sync-worker",
        action: "other_channel_isolated_skip",
        entityType: "product",
        entityId: productId,
        after: { isolatedChannel: otherChannel, reasons: isolation.reasons },
      });
      return;
    }

    const [accountId] = await listConnectedAccountIds(db, tenantId, otherChannel);
    if (!accountId) {
      if (phaseA.sale.soldOut) {
        throw new Error(`Sold out on ${sale.channel} but no ${otherChannel} account is connected to zero it out`);
      }
      // Not sold out — the other channel's own next scheduled/triggered sync will catch
      // this up once it's reconnected; nothing urgent enough to fail the whole sale event.
      return;
    }
    const adapter = adapters[otherChannel];
    if (!adapter) {
      // Can't actually happen today -- singleOtherChannel() already throws before this point
      // for any channel outside IMPLEMENTED_CHANNELS, and loadImplementedChannelAdapters()
      // covers exactly IMPLEMENTED_CHANNELS. Guarded anyway so a future gap between those two
      // fails loudly here rather than crashing on a bare undefined a few lines down.
      throw new Error(`No ChannelAdapter wired for "${otherChannel}" -- loadImplementedChannelAdapters() is out of sync with IMPLEMENTED_CHANNELS`);
    }
    const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

    // Recomputed fresh, live, right before pushing -- never trusted from whenever Phase A
    // actually ran, since this call may be a retry happening well after that.
    let pushedQuantity: number;
    if (phaseA.sale.soldOut) {
      pushedQuantity = 0;
    } else {
      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
      const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
      if (!product || !inventory) return; // nothing to push without both rows
      pushedQuantity = calculateChannelAvailableQuantity(
        inventory.quantity,
        inventory.safetyStockBuffer,
        otherChannel,
        product.sourceChannel,
      );
    }
    await adapter.setInventory(accessToken, otherListing.externalId, pushedQuantity);

    await db
      .update(channelListings)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, otherChannel)));
    await db.update(syncJobs).set({ status: "completed", updatedAt: new Date() }).where(eq(syncJobs.id, job.id));

    await recordAuditLog(db, {
      tenantId,
      actor: "system:inventory-sync-worker",
      action: phaseA.sale.soldOut ? "inventory_zeroed_due_to_sale" : "inventory_immediate_sync_after_sale",
      entityType: "product",
      entityId: productId,
      after: { soldOnChannel: sale.channel, orderId: sale.externalOrderId, syncedChannel: otherChannel, pushedQuantity },
    });
  } catch (err) {
    const error = err as Error;
    await db
      .update(syncJobs)
      .set({ status: "failed", attempts: job.attempts + 1, updatedAt: new Date() })
      .where(eq(syncJobs.id, job.id));
    await recordSyncError(db, {
      tenantId,
      channel: sale.channel,
      productId,
      jobId: job.id,
      errorCode: "channel_inventory_push_failed",
      errorMessage: error.message,
      payload: { externalOrderId: sale.externalOrderId },
    });
    throw new PhaseBDispatchError(error);
  }
}
