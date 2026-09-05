/**
 * Item #3 of the commercial-features round ("売上・利益管理"). A single pure function fed
 * entirely by one order's own stored fields -- never an accumulator that adds to a
 * previously-computed number -- so recomputing it after a return/refund updates those same
 * fields is idempotent by construction: re-running this on the same order can only ever
 * *replace* the prior figure, never add another copy of it on top. That's what "returnAmount
 * comes in as a cost line here rather than a separate reversal entry elsewhere" buys.
 *
 * All monetary inputs land in USD cents, matching this platform's existing FX/pricing
 * convention (see @ai-ec/core's pricing.ts) -- JPY-denominated components (cost, BASE-side
 * sale price, domestic shipping) are converted here via a supplied live FX rate rather than
 * assumed to already be comparable to the USD-denominated eBay-side fees/ad spend/FX cost.
 */
export interface OrderProfitInputs {
  /** JPY per unit acquisition cost, snapshotted at sale time (product_master.cost_jpy can
   *  change later; the order's own snapshot is what profit history should reflect). */
  costJpy: number | null;
  /** Set for a BASE sale. */
  salePriceJpy: number | null;
  /** Set for an eBay sale. */
  salePriceUsdCents: number | null;
  ebayFeeUsdCents: number | null;
  paymentFeeUsdCents: number | null;
  shippingCostJpy: number | null;
  adSpendUsdCents: number | null;
  fxCostUsdCents: number | null;
  /** Amount refunded to the buyer, if this order was returned. */
  returnAmountUsdCents: number | null;
  /** USD per JPY, e.g. from fetchFxRate(). */
  usdPerJpy: number;
}

export interface OrderProfitResult {
  revenueUsdCents: number;
  costUsdCents: number;
  netProfitUsdCents: number;
  /** Basis points (10000 = 100%). Null when revenue is 0 -- a margin against no revenue
   *  isn't a meaningful percentage. */
  profitMarginBasisPoints: number | null;
}

function jpyToUsdCents(jpy: number, usdPerJpy: number): number {
  return Math.round(jpy * usdPerJpy * 100);
}

export function computeOrderProfit(inputs: OrderProfitInputs): OrderProfitResult {
  const revenueUsdCents =
    inputs.salePriceUsdCents ?? (inputs.salePriceJpy != null ? jpyToUsdCents(inputs.salePriceJpy, inputs.usdPerJpy) : 0);

  const costUsdCents =
    (inputs.costJpy != null ? jpyToUsdCents(inputs.costJpy, inputs.usdPerJpy) : 0) +
    (inputs.shippingCostJpy != null ? jpyToUsdCents(inputs.shippingCostJpy, inputs.usdPerJpy) : 0) +
    (inputs.ebayFeeUsdCents ?? 0) +
    (inputs.paymentFeeUsdCents ?? 0) +
    (inputs.adSpendUsdCents ?? 0) +
    (inputs.fxCostUsdCents ?? 0) +
    (inputs.returnAmountUsdCents ?? 0);

  const netProfitUsdCents = revenueUsdCents - costUsdCents;
  const profitMarginBasisPoints = revenueUsdCents > 0 ? Math.round((netProfitUsdCents / revenueUsdCents) * 10000) : null;

  return { revenueUsdCents, costUsdCents, netProfitUsdCents, profitMarginBasisPoints };
}

/** Whole days between two dates, floored (a same-day sale is 0 days held, not 1). */
export function daysBetween(earlier: Date, later: Date): number {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Profit Velocity = 純利益 ÷ 保有日数 -- net profit per day held, so two products with the
 * same total profit but very different holding times are comparable. Null (not 0 or
 * Infinity) for a same-day sale: dividing by zero holding days isn't a meaningful rate.
 */
export function computeProfitVelocityUsdCentsPerDay(netProfitUsdCents: number, holdingDays: number): number | null {
  if (holdingDays <= 0) return null;
  return netProfitUsdCents / holdingDays;
}
