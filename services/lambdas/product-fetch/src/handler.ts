import { BaseAdapter } from "@ai-ec/adapter-base";
import { contentHash, type ExternalProduct } from "@ai-ec/core";
import { applyBaseStockReport, channelListings, inventoryMaster, productMaster, type Database } from "@ai-ec/db";
import {
  enqueue,
  getAppCredentials,
  getDb,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
} from "@ai-ec/lambda-shared";
import { and, eq } from "drizzle-orm";

interface BaseAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Scheduled (EventBridge) poller: pulls BASE's product catalog into the Product Master.
 * BASE is always the origin for product data — this lambda only ever creates/updates
 * product_master rows sourced from BASE, never the reverse.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const creds = await getAppCredentials<BaseAppCredentials>("base");
  const adapter = new BaseAdapter(creds);

  const accountIds = await listConnectedAccountIds(db, "base");
  for (const accountId of accountIds) {
    const accessToken = await getValidAccessToken(db, adapter, accountId);

    let cursor: string | undefined;
    do {
      const { items, nextCursor } = await adapter.listProducts(accessToken, { cursor });
      for (const item of items) {
        // BASE's list endpoint (items/search) only ever returns up to 5 image slots
        // (img1_origin..img5_origin) by design -- confirmed against BASE's own API
        // reference -- while items/detail supports the full 20. A real product with 6+
        // photos would silently lose the rest if we trusted the list response's images,
        // so re-fetch the authoritative per-item detail before upserting.
        const detail = await adapter.getProduct(accessToken, item.externalId);
        await upsertProduct(db, queues, detail ?? item);
      }
      cursor = nextCursor;
    } while (cursor);
  }
}

export async function upsertProduct(
  db: Database,
  queues: ReturnType<typeof getQueueUrls>,
  item: ExternalProduct,
): Promise<void> {
  const sku = `base-${item.externalId}`;
  const hash = contentHash({
    title: item.title,
    descriptionHtml: item.descriptionHtml,
    priceJpy: item.priceJpy,
    images: item.images,
  });

  const [existing] = await db.select().from(productMaster).where(eq(productMaster.sku, sku)).limit(1);

  if (existing) {
    // contentHash covers title/description/price/images only, not stock -- a poll where
    // *only* BASE's stock number changed (a restock, or a manual adjustment BASE never
    // reports as an "order") would otherwise never reach inventory_master at all. Always
    // reconcile the reported stock; applyBaseStockReport itself is the no-op guard when
    // nothing has actually changed on BASE (its out-of-order check on item.updatedAt).
    await applyBaseStockReport(db, existing.id, item.quantity, item.updatedAt);
  }

  if (existing && existing.contentHash === hash) {
    return; // no other field changed since last import
  }

  let productId: string;
  if (existing) {
    await db
      .update(productMaster)
      .set({
        title: item.title,
        descriptionJa: item.descriptionHtml,
        priceJpy: item.priceJpy,
        images: item.images,
        contentHash: hash,
        updatedAt: new Date(),
      })
      .where(eq(productMaster.id, existing.id));
    productId = existing.id;
  } else {
    const [inserted] = await db
      .insert(productMaster)
      .values({
        sku,
        sourceChannel: "base",
        title: item.title,
        descriptionJa: item.descriptionHtml,
        priceJpy: item.priceJpy,
        images: item.images,
        status: "draft",
        contentHash: hash,
      })
      .returning();
    productId = inserted!.id;

    await db.insert(inventoryMaster).values({
      productId,
      quantity: item.quantity,
      version: 0,
      soldOut: item.quantity === 0,
      // Baseline the logical clock watermark to this first-seen BASE state, so the next
      // poll's applyBaseStockReport has something to compare against.
      lastBaseSeq: item.updatedAt,
    });
    await db.insert(channelListings).values({
      productId,
      channel: "base",
      externalId: item.externalId,
      status: "published",
      lastSyncedAt: new Date(),
    });

    await enqueue(queues.aiGenerate, { type: "ai_generate", productId }, `ai-generate:${productId}`);
    return;
  }

  const [ebayListing] = await db
    .select()
    .from(channelListings)
    .where(and(eq(channelListings.productId, productId), eq(channelListings.channel, "ebay")))
    .limit(1);

  // Only push edits automatically for a listing a human already approved & published.
  // A listing still pending approval is left alone — the pending draft/approval flow owns it.
  if (ebayListing?.status === "published") {
    await enqueue(queues.ebaySync, { type: "ebay_update", productId }, `ebay-update:${productId}:${hash}`);
  }
}
