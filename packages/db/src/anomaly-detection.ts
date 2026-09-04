import { and, eq, gte } from "drizzle-orm";
import type { Database } from "./client.js";
import { inventoryEvents } from "./schema.js";

export interface InventoryAnomalyResult {
  productId: string;
  anomalous: boolean;
  reasons: string[];
  windowMinutes: number;
  saleEventCount: number;
  maxSingleSaleQuantity: number;
}

const DEFAULT_WINDOW_MINUTES = 60;
/** More than this many separate sale events for one product within the window looks like a
 *  burst, not ordinary trickle demand. */
const MASS_ORDER_EVENT_COUNT_THRESHOLD = 5;
/** A single sale event moving this many units at once is unusual for a small used-goods shop. */
const SINGLE_SALE_QUANTITY_THRESHOLD = 10;
/** A BASE stock report changing the absolute quantity by this fraction in one step (relative
 *  to the previous report) is treated as suspicious rather than a routine restock/sale. */
const STOCK_REPORT_SWING_RATIO_THRESHOLD = 0.8;
/** A candidate eBay price this far from the last price actually synced to eBay is treated as
 *  suspicious rather than a routine price adjustment. */
const PRICE_SWING_RATIO_THRESHOLD = 0.5;

/**
 * Item #1 of the second hardening round ("異常検知 -- 通常と違う在庫変動・価格変動・
 * 大量注文を自動検知して同期を一時停止"). Detects unusual *inventory* activity for one
 * product from the same event ledger item #1 of the first round introduced
 * (inventory_events) -- never a guessed/invented signal:
 *
 *  - mass orders: an abnormal number of sale events, or one abnormally large sale, in a
 *    trailing window.
 *  - inventory swing: a BASE stock report whose absolute quantity jumped by an abnormal
 *    fraction versus the previous report.
 *
 * Deliberately stateless/re-evaluated on every call (like computeSyncConfidence) rather than
 * a persisted flag someone has to remember to clear -- once the anomalous events age out of
 * the window, or a subsequent report looks normal, the "pause" lifts on its own. See
 * ebay-sync-worker's publish()/update() for where this actually blocks a sync.
 */
export async function detectInventoryAnomaly(
  db: Database,
  productId: string,
  windowMinutes = DEFAULT_WINDOW_MINUTES,
): Promise<InventoryAnomalyResult> {
  const since = new Date(Date.now() - windowMinutes * 60 * 1000);

  const events = await db
    .select()
    .from(inventoryEvents)
    .where(
      and(
        eq(inventoryEvents.productId, productId),
        eq(inventoryEvents.applied, true),
        gte(inventoryEvents.sequenceAt, since),
      ),
    )
    .orderBy(inventoryEvents.sequenceAt);

  const reasons: string[] = [];

  const saleEvents = events.filter((e) => e.eventType === "sale");
  const saleEventCount = saleEvents.length;
  const maxSingleSaleQuantity = saleEvents.reduce((max, e) => Math.max(max, e.quantityDelta ?? 0), 0);

  if (saleEventCount > MASS_ORDER_EVENT_COUNT_THRESHOLD) {
    reasons.push(
      `${saleEventCount} sale events for this product in the last ${windowMinutes}min ` +
        `(threshold ${MASS_ORDER_EVENT_COUNT_THRESHOLD})`,
    );
  }
  if (maxSingleSaleQuantity >= SINGLE_SALE_QUANTITY_THRESHOLD) {
    reasons.push(
      `a single sale event moved ${maxSingleSaleQuantity} units ` +
        `(threshold ${SINGLE_SALE_QUANTITY_THRESHOLD})`,
    );
  }

  const stockReports = events.filter((e) => e.eventType === "base_stock_report" && e.absoluteQuantity != null);
  for (let i = 1; i < stockReports.length; i += 1) {
    const prev = stockReports[i - 1]!.absoluteQuantity!;
    const curr = stockReports[i]!.absoluteQuantity!;
    if (prev <= 0) continue; // nothing to compute a meaningful ratio against
    const ratio = Math.abs(curr - prev) / prev;
    if (ratio >= STOCK_REPORT_SWING_RATIO_THRESHOLD) {
      reasons.push(
        `BASE-reported stock swung ${Math.round(ratio * 100)}% in one report ` +
          `(${prev} -> ${curr}, threshold ${Math.round(STOCK_REPORT_SWING_RATIO_THRESHOLD * 100)}%)`,
      );
      break;
    }
  }

  return { productId, anomalous: reasons.length > 0, reasons, windowMinutes, saleEventCount, maxSingleSaleQuantity };
}

export interface PriceAnomalyResult {
  anomalous: boolean;
  reason?: string;
}

/**
 * Price half of item #1: compares a candidate eBay price against the last price this
 * platform actually synced to eBay (channel_listings.lastSyncedPriceJpy) rather than a
 * fabricated "expected" price. No prior synced price (a brand-new listing) is never
 * anomalous -- there is nothing to compare against yet.
 */
export function detectPriceAnomaly(lastSyncedPriceJpy: number | null, candidatePriceJpy: number): PriceAnomalyResult {
  if (lastSyncedPriceJpy === null || lastSyncedPriceJpy <= 0) return { anomalous: false };
  const ratio = Math.abs(candidatePriceJpy - lastSyncedPriceJpy) / lastSyncedPriceJpy;
  if (ratio < PRICE_SWING_RATIO_THRESHOLD) return { anomalous: false };
  return {
    anomalous: true,
    reason:
      `price would change ${Math.round(ratio * 100)}% versus the last price synced to eBay ` +
      `(¥${lastSyncedPriceJpy} -> ¥${candidatePriceJpy}, threshold ${Math.round(PRICE_SWING_RATIO_THRESHOLD * 100)}%)`,
  };
}
