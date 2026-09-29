/**
 * The 在庫監視 page's differential magnitude bucketing. There is no existing severity scale
 * anywhere in this codebase for inventory drift -- inventory-diff-check (services/lambdas/
 * inventory-diff-check) only records a strict liveQuantity !== expectedQuantity mismatch as
 * a sync_errors row, with no tolerance band. This is a new, small, real classification layer
 * on top of that: once a drift IS flagged, how far off is it. Thresholds are deliberately
 * conservative (small drifts are common noise from timing between polls; 3+ units off is
 * worth a human look).
 */
export type InventoryDiffCode = "normal" | "attention" | "possible_double_sale" | "sold_out";

export function classifyInventoryDiffMagnitude(diff: number): "normal" | "attention" {
  return Math.abs(diff) <= 2 ? "normal" : "attention";
}
