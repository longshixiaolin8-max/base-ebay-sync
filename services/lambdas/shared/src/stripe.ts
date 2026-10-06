import Stripe from "stripe";

export interface StripeAppCredentials {
  secretKey: string;
  publishableKey: string;
  /** The "standard" plan's price -- kept as the one required field so an existing,
   *  already-filled-in secret (single-tier era) keeps working unchanged after this field
   *  was joined by `priceIds` below. */
  priceId: string;
  /** Multi-tier commercial launch: additional plans' own Stripe Price ids, keyed by the
   *  same plan name packages/core/src/plan-limits.ts uses. Optional and additive --
   *  omitting it (or any one entry) just means that tier has no real Stripe price to sell
   *  yet, not a broken config. "standard" is intentionally never read from here; `priceId`
   *  above is always its source of truth, so the two can never disagree. */
  priceIds?: Record<string, string>;
  webhookSigningSecret: string;
}

/** Builds a Stripe SDK client from the stored test-mode credentials (see getAppCredentials("stripe")). */
export function createStripeClient(creds: StripeAppCredentials): Stripe {
  return new Stripe(creds.secretKey);
}

/** Every plan name this account currently has a real Stripe Price for, each mapped to that
 *  Price's id -- "standard" always included (from `priceId`), any configured `priceIds`
 *  entries added on top. Used both to resolve "which price do I charge for this plan" at
 *  checkout time and, in reverse, "which plan did this Price id's subscription just pay
 *  for" when a Stripe webhook event arrives. */
export function resolvePlanPriceIds(creds: StripeAppCredentials): Record<string, string> {
  return { ...creds.priceIds, standard: creds.priceId };
}

/** Reverse of resolvePlanPriceIds: given a Stripe Price id actually on a subscription,
 *  returns the plan name it corresponds to, or "standard" if the price id matches none of
 *  the configured plans -- the same safe fallback getPlanLimits() itself uses for an
 *  unrecognized plan name, so an unmapped price never silently grants an unintended tier. */
export function resolvePlanFromPriceId(creds: StripeAppCredentials, priceId: string): string {
  const entries = Object.entries(resolvePlanPriceIds(creds));
  return entries.find(([, id]) => id === priceId)?.[0] ?? "standard";
}
