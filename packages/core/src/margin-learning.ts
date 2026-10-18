import type { StaleLevel } from "./stale.js";

export type MarginBaselineSource = "tenant_history" | "fallback_default";

export interface LearnedMarginInput {
  /** This tenant's own average realized net-margin ratio across its past finalized eBay
   *  orders (see packages/db/src/orders.ts's getTenantMarginHistory) -- null when there is
   *  no history to draw from yet. */
  historicalAvgMarginRatio: number | null;
  /** How many finalized orders that average is drawn from. Too small a sample is noise, not
   *  a signal, so it's ignored below MIN_SAMPLE_SIZE_FOR_HISTORY regardless of its value. */
  sampleSize: number;
  /** The tenant's (or platform's) configured static default, used whenever history is too
   *  thin -- same value resolveTenantPricingDefaults already falls back to today. */
  fallbackMarginRatio: number;
  staleness: StaleLevel;
  /** True when predictStockoutRisk flags this product as high risk (selling fast enough to
   *  run out soon) -- the "fast mover" half of the velocity-based repricing pattern below. */
  highDemand: boolean;
}

export interface LearnedMarginResult {
  targetMarginRatio: number;
  baselineMarginRatio: number;
  baselineSource: MarginBaselineSource;
  /** The staleness/demand nudge actually applied, in the same ratio units (e.g. -0.06). */
  adjustmentRatio: number;
  adjustmentReason: string;
}

/** Below this many finalized orders, a tenant's own average margin is too noisy to trust as
 *  a baseline -- fall back to the configured default instead. */
const MIN_SAMPLE_SIZE_FOR_HISTORY = 5;
/** Never recommend a margin below this, however stale the product -- the guardrail every
 *  write-up on algorithmic repricing calls out as non-negotiable (a repricer without a
 *  margin floor can walk a price down to a loss). */
const MARGIN_FLOOR_RATIO = 0.05;

const STALENESS_ADJUSTMENT_RATIO: Record<StaleLevel, number> = {
  fresh: 0,
  stale_30: -0.03,
  stale_60: -0.06,
  stale_90: -0.1,
};

/** Extra margin captured on a product that's both fresh and selling fast -- the "fast
 *  movers maintained or slightly increased" half of the same pattern that discounts slow
 *  movers below. Only applies when the product isn't already stale (a stale-but-suddenly-
 *  selling item should clear, not get more expensive). */
const HIGH_DEMAND_ADJUSTMENT_RATIO = 0.03;

/**
 * Replaces this platform's previous flat, one-size-fits-all DEFAULT_TARGET_MARGIN_RATIO
 * fallback with a margin that is (a) personalized -- anchored on this tenant's own realized
 * profit history instead of a generic constant -- and (b) responsive to each specific
 * product's real sales signal, following the two patterns that hold up across published
 * repricing guidance for small sellers: slow movers get discounted to clear, fast movers
 * keep (or slightly improve) their margin, and every recommendation stays above a hard
 * floor. Deliberately NOT competitor-price-matching or elasticity-tested pricing -- this
 * platform has no competitor-price feed and no safe way to run live price experiments on a
 * single seller's small catalog, so it only ever adjusts around a merchant's own true cost
 * and their own track record, never guesses at market price.
 *
 * Only ever the FALLBACK layer: a merchant's own explicit per-product targetMarginBasisPoints
 * override (set via POST /admin/products/{id}/pricing-config) always wins outright and never
 * reaches this function at all -- this is strictly what fills in when they haven't set one.
 */
export function computeLearnedTargetMargin(input: LearnedMarginInput): LearnedMarginResult {
  const hasEnoughHistory = input.historicalAvgMarginRatio !== null && input.sampleSize >= MIN_SAMPLE_SIZE_FOR_HISTORY;
  const baselineMarginRatio = hasEnoughHistory ? input.historicalAvgMarginRatio! : input.fallbackMarginRatio;
  const baselineSource: MarginBaselineSource = hasEnoughHistory ? "tenant_history" : "fallback_default";

  const highDemandApplies = input.staleness === "fresh" && input.highDemand;
  const adjustmentRatio = highDemandApplies ? HIGH_DEMAND_ADJUSTMENT_RATIO : STALENESS_ADJUSTMENT_RATIO[input.staleness];

  const adjustmentReason = highDemandApplies
    ? "売れ行きが良いため、利益をわずかに上乗せしました"
    : adjustmentRatio < 0
      ? "長期間売れていないため、値下げして回転を優先しました"
      : "調整なし";

  const targetMarginRatio = Math.max(MARGIN_FLOOR_RATIO, baselineMarginRatio + adjustmentRatio);

  return { targetMarginRatio, baselineMarginRatio, baselineSource, adjustmentRatio, adjustmentReason };
}
