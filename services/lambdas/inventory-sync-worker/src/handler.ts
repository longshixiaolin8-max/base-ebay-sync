import { BaseAdapter } from "@ai-ec/adapter-base";
import { buildIdempotencyKey, withIdempotency, type ChannelAdapter, type ChannelType, type SaleEvent } from "@ai-ec/core";
import { applySale, channelListings, productMaster } from "@ai-ec/db";
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
  const result = await applySale(db, productId, sale.quantitySold);

  if (!result.soldOut || result.alreadyZero) {
    // Either still in stock, or another event already drove this to zero first — the
    // double-sell guard: whichever sale arrives first wins, this one is a safe no-op.
    return;
  }

  const otherChannel = otherChannelOf(sale.channel);
  const [otherListing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, otherChannel)))
    .limit(1);

  await db.update(productMaster).set({ status: "sold_out", updatedAt: new Date() }).where(eq(productMaster.id, productId));

  if (otherListing?.status === "published" && otherListing.externalId) {
    const [accountId] = await listConnectedAccountIds(db, otherChannel);
    if (!accountId) {
      throw new Error(`Sold out on ${sale.channel} but no ${otherChannel} account is connected to zero it out`);
    }
    const adapter = adapters[otherChannel];
    const accessToken = await getValidAccessToken(db, adapter, accountId);
    await adapter.setInventory(accessToken, otherListing.externalId, 0);

    await db
      .update(channelListings)
      .set({ lastSyncedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, otherChannel)));
  }

  await recordAuditLog(db, {
    actor: "system:inventory-sync-worker",
    action: "inventory_zeroed_due_to_sale",
    entityType: "product",
    entityId: productId,
    after: { soldOnChannel: sale.channel, orderId: sale.externalOrderId, zeroedChannel: otherChannel },
  });
}

function notImplementedAdapter(channel: string): ChannelAdapter {
  return new Proxy({} as ChannelAdapter, {
    get() {
      throw new Error(`Channel adapter "${channel}" is not implemented yet`);
    },
  });
}
