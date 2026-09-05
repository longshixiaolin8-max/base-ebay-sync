import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { calculateChannelAvailableQuantity } from "./inventory.js";
import { listReservedOrdersForProduct } from "./orders.js";
import { channelListings, inventoryMaster, productMaster } from "./schema.js";

export interface InventoryBreakdown {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

/**
 * Item #2 of the commercial-features round ("在庫を分離"). Maps onto inventory_master's
 * existing fields rather than introducing a parallel counter: on_hand and available are both
 * inventory_master.quantity (a sale is decremented from true stock the moment it's detected
 * -- see applySale -- there is no separate "picked but not yet shipped" hold state that would
 * need subtracting from it), and safety_buffer/sellable-per-channel are exactly the existing
 * safety_stock_buffer column and calculateChannelAvailableQuantity's result. `reserved` is
 * the one genuinely new figure: units tied up in orders placed but not yet shipped -- an
 * operational "how much am I on the hook to ship" metric for reporting, deliberately NOT
 * subtracted from on_hand/available, since applySale already subtracted those units from
 * true stock the moment the sale was detected -- subtracting them again here would double-count.
 */
export async function getInventoryBreakdown(db: Database, productId: string): Promise<InventoryBreakdown | null> {
  const [product] = await db.select().from(productMaster).where(eq(productMaster.id, productId)).limit(1);
  const [inv] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  if (!product || !inv) return null;

  const reservedOrders = await listReservedOrdersForProduct(db, productId);
  const reserved = reservedOrders.reduce((sum, o) => sum + o.quantity, 0);

  const listings = await db.select().from(channelListings).where(eq(channelListings.productId, productId));
  const sellableByChannel: Record<string, number> = {};
  for (const listing of listings) {
    sellableByChannel[listing.channel] = calculateChannelAvailableQuantity(
      inv.quantity,
      inv.safetyStockBuffer,
      listing.channel,
      product.sourceChannel,
    );
  }

  return {
    productId,
    onHand: inv.quantity,
    reserved,
    available: inv.quantity,
    safetyBuffer: inv.safetyStockBuffer,
    sellableByChannel,
  };
}
