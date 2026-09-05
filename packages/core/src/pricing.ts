export interface DynamicPriceInput {
  costJpy: number;
  /** Real, live JPY->USD rate (e.g. from a currency API) -- never a hardcoded constant. */
  fxRateUsdPerJpy: number;
  /** The seller's own real cost to ship the item, in USD -- borne out of net proceeds. */
  shippingUsd: number;
  /** e.g. 0.3 for a 30% target margin over cost. */
  targetMarginRatio: number;
  /** eBay's Final Value Fee as a fraction of the transaction total. Defaults to eBay's
   *  published Jewelry & Watches rate (15%, for transactions up to $5,000) -- confirmed
   *  against eBay's current seller-fees schedule, not guessed. */
  ebayFeeRatio?: number;
  /** eBay's flat per-order fee in USD. Defaults to $0.40 (the >$10 order tier, which is
   *  the realistic case for this platform's price range). */
  ebayPerOrderFeeUsd?: number;
}

export interface DynamicPriceResult {
  costUsd: number;
  recommendedPriceUsd: number;
  ebayFeeUsd: number;
  netProceedsUsd: number;
  /** The margin this price actually achieves, for a sanity check against targetMarginRatio. */
  netMarginRatio: number;
  fxRateUsdPerJpy: number;
  shippingUsd: number;
  ebayFeeRatio: number;
  ebayPerOrderFeeUsd: number;
}

/** eBay Jewelry & Watches Final Value Fee, transactions up to $5,000 -- confirmed against
 *  eBay's current published seller-fees schedule (community.ebay.com/ebay.com/help). */
export const DEFAULT_EBAY_FEE_RATIO = 0.15;
/** eBay's flat per-order fee for orders over $10. */
export const DEFAULT_EBAY_PER_ORDER_FEE_USD = 0.4;
export const DEFAULT_TARGET_MARGIN_RATIO = 0.3;
export const DEFAULT_SHIPPING_USD = 0;

/**
 * Item #4 of the third hardening round ("価格の動的整合 -- 為替、eBay手数料、送料、
 * 利益率を加味して販売価格を自動決定"). Solves for the USD list price that, after eBay's
 * real fee structure and the seller's real shipping cost are deducted, leaves net proceeds
 * exactly targetMarginRatio above the JPY cost converted at a real, live FX rate.
 *
 * Assumes free shipping to the buyer (eBay's Final Value Fee base is then just the list
 * price) with the seller absorbing the real shipping cost out of net proceeds -- the
 * common setup for this kind of listing, and the only shipping model this platform has any
 * real cost data for.
 *
 *   revenue = P
 *   fee = P * ebayFeeRatio + ebayPerOrderFeeUsd
 *   net = P - fee - shippingUsd
 *   net = costUsd * (1 + targetMarginRatio)   (the target)
 *   => P = (costUsd * (1 + targetMarginRatio) + shippingUsd + ebayPerOrderFeeUsd) / (1 - ebayFeeRatio)
 */
export function computeDynamicPrice(input: DynamicPriceInput): DynamicPriceResult {
  const ebayFeeRatio = input.ebayFeeRatio ?? DEFAULT_EBAY_FEE_RATIO;
  const ebayPerOrderFeeUsd = input.ebayPerOrderFeeUsd ?? DEFAULT_EBAY_PER_ORDER_FEE_USD;
  const costUsd = input.costJpy * input.fxRateUsdPerJpy;

  const recommendedPriceUsd =
    (costUsd * (1 + input.targetMarginRatio) + input.shippingUsd + ebayPerOrderFeeUsd) / (1 - ebayFeeRatio);
  const ebayFeeUsd = recommendedPriceUsd * ebayFeeRatio + ebayPerOrderFeeUsd;
  const netProceedsUsd = recommendedPriceUsd - ebayFeeUsd - input.shippingUsd;
  const netMarginRatio = costUsd > 0 ? (netProceedsUsd - costUsd) / costUsd : 0;

  return {
    costUsd,
    recommendedPriceUsd: Math.round(recommendedPriceUsd * 100) / 100,
    ebayFeeUsd: Math.round(ebayFeeUsd * 100) / 100,
    netProceedsUsd: Math.round(netProceedsUsd * 100) / 100,
    netMarginRatio,
    fxRateUsdPerJpy: input.fxRateUsdPerJpy,
    shippingUsd: input.shippingUsd,
    ebayFeeRatio,
    ebayPerOrderFeeUsd,
  };
}
