import Link from "next/link";

interface PlanUsageWidgetProps {
  planLabel: string;
  productsUsed: number;
  productsLimit: number;
}

/** Sidebar footer widget from the image ("スタンダードプラン" / usage bar / "プランを変更").
 *  Real numbers from GET /admin/usage + GET /admin/billing/status -- e.g. this plan's real
 *  product limit is 300 (packages/core/src/plan-limits.ts), not the image's placeholder 3,000. */
export function PlanUsageWidget({ planLabel, productsUsed, productsLimit }: PlanUsageWidgetProps) {
  const pct = productsLimit > 0 ? Math.min(100, Math.round((productsUsed / productsLimit) * 100)) : 0;
  return (
    <div className="plan-usage-widget">
      <div className="plan-usage-widget-name">{planLabel}</div>
      <div className="plan-usage-widget-desc">商品登録数 {productsLimit.toLocaleString()}件まで</div>
      <Link href="/billing" className="secondary plan-usage-widget-cta">
        プランを変更
      </Link>
      <div className="plan-usage-widget-bar">
        <div className="plan-usage-widget-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="plan-usage-widget-count">
        {productsUsed.toLocaleString()} / {productsLimit.toLocaleString()}
      </div>
    </div>
  );
}
