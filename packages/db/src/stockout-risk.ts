import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryEvents, inventoryMaster } from "./schema.js";

export interface StockoutRiskResult {
  productId: string;
  /** Estimated days of stock left at the current sales pace. null when there's no
   *  measurable velocity (nothing sold recently) or nothing left to protect (already 0). */
  daysUntilStockout: number | null;
  highRisk: boolean;
  salesPerDay: number;
  currentQuantity: number;
  windowDays: number;
}

const DEFAULT_WINDOW_DAYS = 7;
/** Fewer than this many days of stock left at the current pace counts as high risk --
 *  the next unit sold is disproportionately likely to be the last one. */
const HIGH_RISK_DAYS_THRESHOLD = 3;
/** Extra units withheld from public availability for a high-risk product, on top of the
 *  ordinary dynamic safety-stock buffer -- see resolveSafetyStockBuffer in ebay-sync-worker. */
export const PREEMPTIVE_STOCKOUT_BUFFER = 1;

/**
 * Item #5 of the second hardening round ("予測型在庫制御 -- 売れ行きを予測して、
 * 売り切れリスクが高い商品だけ事前に公開在庫を下げる"). Reuses the same inventory_events
 * ledger and sales-velocity math as computeDynamicSafetyStock (item #2 of the first round),
 * but asks a different question: not "how much buffer does *every* product need against
 * sync lag" but "which *specific* products are about to sell out at their current pace" --
 * so only those get an extra preemptive cut, everything else is untouched by this.
 */
export async function predictStockoutRisk(
  db: Database,
  productId: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<StockoutRiskResult> {
  const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, productId)).limit(1);
  const currentQuantity = inventory?.quantity ?? 0;

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sales = await db
    .select()
    .from(inventoryEvents)
    .where(
      and(
        eq(inventoryEvents.productId, productId),
        eq(inventoryEvents.eventType, "sale"),
        eq(inventoryEvents.applied, true),
        gte(inventoryEvents.createdAt, since),
      ),
    );
  const totalSold = sales.reduce((sum, s) => sum + (s.quantityDelta ?? 0), 0);
  const salesPerDay = totalSold / windowDays;

  if (salesPerDay <= 0 || currentQuantity <= 0) {
    // No measurable velocity to extrapolate from, or already at zero -- an actual sellout
    // is a different, already-handled concern (see applySale); this is only about
    // *predicting* one before it happens.
    return { productId, daysUntilStockout: null, highRisk: false, salesPerDay, currentQuantity, windowDays };
  }

  const daysUntilStockout = currentQuantity / salesPerDay;
  return {
    productId,
    daysUntilStockout,
    highRisk: daysUntilStockout < HIGH_RISK_DAYS_THRESHOLD,
    salesPerDay,
    currentQuantity,
    windowDays,
  };
}
