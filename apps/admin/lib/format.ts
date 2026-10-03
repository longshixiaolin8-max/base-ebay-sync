/** For fast triage at a glance -- the absolute timestamp (still shown alongside it, where
 *  space allows) is the exact record; this is just how long it's been sitting.
 *  Previously duplicated in sync-errors/page.tsx; centralized here now that the dashboard's
 *  sync-topology card and activity feed need the exact same formatting. */
export function relativeTime(date: Date | string): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  return `${days}日前`;
}

/** This platform currently offers exactly one plan tier (packages/core/src/plan-limits.ts);
 *  falls back to the raw plan id so a future new tier still renders something instead of
 *  silently showing nothing. Shared between /billing and the sidebar's plan-usage widget. */
export function planLabel(plan: string): string {
  return plan === "standard" ? "スタンダードプラン" : plan;
}

const STRIPE_ZERO_DECIMAL_CURRENCIES = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
]);

/** Stripe reports amounts in the currency's smallest unit. JPY and the other zero-decimal
 * currencies are already whole units, while USD/EUR/etc. need division by 100. */
export function stripeMinorToMajor(amount: number, currency: string): number {
  return STRIPE_ZERO_DECIMAL_CURRENCIES.has(currency.toLowerCase()) ? amount : amount / 100;
}

export function formatStripeAmount(
  amount: number,
  currency: string,
  locale = "ja-JP",
): string {
  const normalizedCurrency = currency.toUpperCase();
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: normalizedCurrency,
  }).format(stripeMinorToMajor(amount, currency));
}
