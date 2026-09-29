import type { ChannelByMonth } from "./types";

/**
 * A new STACKED (not grouped) bar chart -- orders/ChannelProfitChart.tsx is explicitly grouped
 * (side-by-side bars per category), so this is a different, purpose-built layout rather than a
 * variant of it.
 */
export function StackedChannelBarChart({ data, formatJpy }: { data: ChannelByMonth[]; formatJpy: (jpy: number) => string }) {
  const maxTotal = Math.max(1, ...data.map((d) => d.baseRevenueJpy + d.ebayRevenueJpy));

  return (
    <div className="stacked-bar-chart">
      <div className="chart-legend">
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#3aa876" }} /> eBay
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE
        </span>
      </div>
      <div className="stacked-bar-groups">
        {data.map((d) => {
          const total = d.baseRevenueJpy + d.ebayRevenueJpy;
          const heightPct = (total / maxTotal) * 100;
          const ebayPct = total > 0 ? (d.ebayRevenueJpy / total) * 100 : 0;
          return (
            <div key={d.month} className="stacked-bar-col">
              <div className="stacked-bar-total">{formatJpy(total)}</div>
              <div className="stacked-bar-track" style={{ height: `${heightPct}%` }}>
                <div className="stacked-bar-segment" style={{ height: `${ebayPct}%`, background: "#3aa876" }} title={`eBay: ${formatJpy(d.ebayRevenueJpy)}`} />
                <div className="stacked-bar-segment" style={{ height: `${100 - ebayPct}%`, background: "#2a78d6" }} title={`BASE: ${formatJpy(d.baseRevenueJpy)}`} />
              </div>
              <div className="stacked-bar-label">{d.month}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
