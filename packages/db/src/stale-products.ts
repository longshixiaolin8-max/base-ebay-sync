import { classifyStaleness, daysBetween, type StaleLevel } from "@ai-ec/core";
import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryMaster, productMaster } from "./schema.js";

export interface StaleProduct {
  productId: string;
  sku: string;
  title: string;
  daysListed: number;
  level: StaleLevel;
}

/**
 * Item #5 of the commercial-features round ("滞留商品管理"). "Listed" date is
 * product_master.created_at (when this platform first pulled the product in from BASE) --
 * the simplest available proxy, since BASE is always the origin for every product. Two
 * separate queries merged in application code (this codebase's established style -- see
 * sync-trace.ts -- rather than a SQL join) so results are easy to reason about and test.
 */
export async function findStaleProducts(db: Database, minDaysListed = 30): Promise<StaleProduct[]> {
  const [products, inventories] = await Promise.all([
    db.select().from(productMaster),
    db.select().from(inventoryMaster).where(eq(inventoryMaster.soldOut, false)),
  ]);
  const notSoldOut = new Set(inventories.map((i) => i.productId));
  const now = new Date();

  return products
    .filter((p) => notSoldOut.has(p.id))
    .map((p) => {
      const daysListed = daysBetween(p.createdAt, now);
      return { productId: p.id, sku: p.sku, title: p.title, daysListed, level: classifyStaleness(daysListed) };
    })
    .filter((p) => p.daysListed >= minDaysListed)
    .sort((a, b) => b.daysListed - a.daysListed);
}
