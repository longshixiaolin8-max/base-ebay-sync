/**
 * Phase 3 of the SaaS conversion ("plan quota enforcement"). Still a single flat plan
 * ("standard") -- this map is the one place its limits live, so a later multi-tier
 * pricing phase only has to add more entries here, not restructure any call site.
 */
export interface PlanLimits {
  maxProducts: number;
  maxAiGenerationsPerMonth: number;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  standard: { maxProducts: 300, maxAiGenerationsPerMonth: 100 },
};

export function getPlanLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.standard!;
}
