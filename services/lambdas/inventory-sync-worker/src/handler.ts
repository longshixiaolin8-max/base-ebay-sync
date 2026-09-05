import { BaseAdapter } from "@ai-ec/adapter-base";
import { buildIdempotencyKey, withIdempotency, type ChannelAdapter, type ChannelType, type SaleEvent } from "@ai-ec/core";
import {
  applySale,
  calculateChannelAvailableQuantity,
  channelListings,
  inventoryMaster,
  isChannelIsolated,
  productMaster,
} from "@ai-ec/db";
import {
  createEbayAdapter,
  getAppCredentials,
  getDb,
  getIdempotencyStore,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  recordSyncError,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";
import type { SQSEvent, SQSHandler } from "aws-lambda";

interface SaleDetectedMessage {
  type: "sale_detected";
  sale: SaleEvent;
}

function otherChannelOf(channel: ChannelType): ChannelType {
  return channel === "base" ? "ebay" : "base";
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const db = getDb();
  const idempotencyStore = getIdempotencyStore();

  const baseCreds = await getAppCredentials<{ clientId: string; clientSecret: string }>("base");
  const ebayCreds = await getAppCredentials<EbayAppCredentials>("ebay");
  const adapters: Record<ChannelType, ChannelAdapter> = {
    base: new BaseAdapter(baseCreds),
    ebay: createEbayAdapter(ebayCreds),
    shopify: notImplementedAdapter("shopify"),
    amazon: notImplementedAdapter("amazon"),
    rakuten: notImplementedAdapter("rakuten"),
  };

  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message = JSON.parse(record.body) as SaleDetectedMessage;
    const { sale } = message;

    try {
      const [listing] = await db
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.channel, sale.channel), eq(channelListings.externalId, sale.externalProductId)))
        .limit(1);
      if (!listing) {
        throw new Error(
          `No channel_listings row maps ${sale.channel}:${sale.externalProductId} to a product — cannot apply sale`,
        );
      }

      const key = buildIdempotencyKey(["sale", sale.channel, sale.externalOrderId, sale.externalProductId]);
      await withIdempotency(idempotencyStore, key, () =>
        processSale(db, adapters, listing.productId, sale),
      );
    } catch (err) {
      const error = err as Error;
      if (error.name !== "IdempotencyInProgressError") {
        await recordSyncError(db, {
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

export async function processSale(
  db: ReturnType<typeof getDb>,
  adapters: Record<ChannelType, ChannelAdapter>,
  productId: string,
  sale: SaleEvent,
): Promise<void> {
  const result = await applySale(db, productId, sale.quantitySold, {
    channel: sale.channel,
    sequenceAt: sale.occurredAt,
    externalEventId: sale.externalOrderId,
  });

  if (result.alreadyZero) {
    // Another event already drove this to zero first — the double-sell guard: whichever
    // sale arrives first wins, this one is a safe no-op.
    return;
  }

  const otherChannel = otherChannelOf(sale.channel);
  const [otherListing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, otherChannel)))
    .limit(1);

  if (result.soldOut) {
    await db.update(productMaster).set({ status: "sold_out", updatedAt: new Date() }).where(eq(productMaster.id, productId));
  }

  if (otherListing?.status === "published" && otherListing.externalId) {
    // Item A of the third hardening round ("チャネル障害時の隔離モード"). This is exactly
    // the scenario a plain "is an account connected?" check can't catch: eBay's
    // oauth_connections row can be present (accountId found) while its stored access token
    // is expired with no refresh token to fall back on -- confirmed live, that failure
    // happens down in getValidAccessToken below, past the connected-account check. Catching
    // it here instead, before spending an attempt on a call already known likely to fail
    // the same way, and treating it as a known, tracked condition rather than a fresh
    // failure to throw and retry-spam on.
    const isolation = await isChannelIsolated(db, otherChannel);
    if (isolation.isolated) {
      await recordAuditLog(db, {
        actor: "system:inventory-sync-worker",
        action: "other_channel_isolated_skip",
        entityType: "product",
        entityId: productId,
        after: { isolatedChannel: otherChannel, reasons: isolation.reasons },
      });
      return;
    }

    const [accountId] = await listConnectedAccountIds(db, otherChannel);
    if (!accountId) {
      if (result.soldOut) {
        throw new Error(`Sold out on ${sale.channel} but no ${otherChannel} account is connected to zero it out`);
      }
      // Not sold out — the other channel's own next scheduled/triggered sync will catch
      // this up once it's reconnected; nothing urgent enough to fail the whole sale event.
      return;
    }
    const adapter = adapters[otherChannel];
    const accessToken = await getValidAccessToken(db, adapter, accountId);

    let pushedQuantity: number;
    if (result.soldOut) {
      pushedQuantity = 0;
    } else {
      // Item #3 of the second hardening round (即時同期, a reinterpretation of 在庫予約ロック:
      // neither BASE nor eBay gives this platform a hook to reserve stock *before* a buyer
      // checks out on either one, so the closest real equivalent is shrinking the window a
      // sale sits unreflected on the other channel). Previously a partial decrement (still
      // in stock afterward) just waited for that channel's own next scheduled/triggered sync
      // cycle to notice — push the freshly-reduced available quantity right now instead.
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

    await recordAuditLog(db, {
      actor: "system:inventory-sync-worker",
      action: result.soldOut ? "inventory_zeroed_due_to_sale" : "inventory_immediate_sync_after_sale",
      entityType: "product",
      entityId: productId,
      after: { soldOnChannel: sale.channel, orderId: sale.externalOrderId, syncedChannel: otherChannel, pushedQuantity },
    });
  }
}

function notImplementedAdapter(channel: string): ChannelAdapter {
  return new Proxy({} as ChannelAdapter, {
    get() {
      throw new Error(`Channel adapter "${channel}" is not implemented yet`);
    },
  });
}
