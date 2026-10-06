/**
 * Phase 3 of the SaaS conversion ("plan quota enforcement"). This map is the one place
 * every plan's limits live -- a call site never hardcodes a number, so adding/resizing a
 * tier only ever means editing this file. maxEbaySyncsPerMonth (added for real multi-tier
 * commercial launch) caps publish+update calls to eBay per month, the other metered,
 * real-cost action besides AI generation -- see ebay-sync-worker's publish()/update().
 */
export interface PlanLimits {
  maxProducts: number;
  maxAiGenerationsPerMonth: number;
  maxEbaySyncsPerMonth: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: { maxProducts: 50, maxAiGenerationsPerMonth: 20, maxEbaySyncsPerMonth: 50 },
  standard: { maxProducts: 300, maxAiGenerationsPerMonth: 100, maxEbaySyncsPerMonth: 300 },
  pro: { maxProducts: 2000, maxAiGenerationsPerMonth: 1000, maxEbaySyncsPerMonth: 3000 },
};

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.standard!;
}
