import type { ChannelBreakdown } from "./types";

const CATEGORIES: Array<{ key: keyof ChannelBreakdown; label: string }> = [
  { key: "revenueJpy", label: "売上" },
  { key: "costJpy", label: "原価" },
  { key: "feesJpy", label: "手数料" },
  { key: "shippingJpy", label: "送料" },
  { key: "profitJpy", label: "利益" },
];

/**
 * New grouped bar chart (5 categories x 2 channels) -- no grouped-bar component existed
 * anywhere in this repo. 利益 also reflects ad spend/FX cost/return amount (not shown as
 * their own bars here), so 売上-原価-手数料-送料 will not always exactly equal 利益 for a
 * channel that has any of those -- same caveat the API response documents.
 */
export function ChannelProfitChart({ base, ebay, formatJpy }: { base: ChannelBreakdown; ebay: ChannelBreakdown; formatJpy: (jpy: number) => string }) {
  const maxValue = Math.max(1, ...CATEGORIES.flatMap((c) => [Math.abs(base[c.key]), Math.abs(ebay[c.key])]));

  return (
    <div className="channel-profit-chart">
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#3aa876" }} /> eBay
        </span>
      </div>
      <div className="channel-profit-groups">
        {CATEGORIES.map((c) => (
          <div key={c.key} className="channel-profit-group">
            <div className="channel-profit-bars">
              <div className="channel-profit-bar-wrap">
                <div className="channel-profit-bar-value">{formatJpy(base[c.key])}</div>
                <div className="channel-profit-bar" style={{ height: `${(Math.abs(base[c.key]) / maxValue) * 100}%`, background: "#2a78d6" }} />
              </div>
              <div className="channel-profit-bar-wrap">
                <div className="channel-profit-bar-value">{formatJpy(ebay[c.key])}</div>
                <div className="channel-profit-bar" style={{ height: `${(Math.abs(ebay[c.key]) / maxValue) * 100}%`, background: "#3aa876" }} />
              </div>
            </div>
            <div className="channel-profit-group-label">{c.label}</div>
          </div>
        ))}
      </div>
      <p className="channel-profit-note">※ 利益には広告費・為替コスト・返金額も反映されるため、売上-原価-手数料-送料と厳密には一致しません。</p>
    </div>
  );
}
