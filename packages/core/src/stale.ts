/** Item #5 of the commercial-features round ("滞留商品管理"). */
export const STALE_THRESHOLD_DAYS = { warning: 30, concerning: 60, critical: 90 } as const;

export type StaleLevel = "fresh" | "stale_30" | "stale_60" | "stale_90";

export function classifyStaleness(daysListed: number): StaleLevel {
  if (daysListed > STALE_THRESHOLD_DAYS.critical) return "stale_90";
  if (daysListed > STALE_THRESHOLD_DAYS.concerning) return "stale_60";
  if (daysListed > STALE_THRESHOLD_DAYS.warning) return "stale_30";
  return "fresh";
}
