import { useState } from "react";
import type { TrendPoint } from "./types";

const WIDTH = 640;
const HEIGHT = 220;
const PAD = 32;

/**
 * A new combo chart (two revenue lines + a faded order-count bar series behind them) -- no
 * such component existed anywhere in this repo. The bars share the plot area with the lines
 * but are independently scaled to their own max (a real dual-axis would need two numeric
 * scales drawn side by side; this hand-rolled SVG keeps the same single-scale-per-series
 * approach as every other chart here, trading exact bar height for a simpler, still-honest
 * "shape of order volume behind the revenue lines" visual -- the tooltip always shows the
 * real number).
 */
export function RevenueTrendChart({ data, formatJpy }: { data: TrendPoint[]; formatJpy: (jpy: number) => string }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  if (data.length === 0) return null;

  const maxRevenue = Math.max(1, ...data.map((d) => Math.max(d.baseRevenueJpy, d.ebayRevenueJpy)));
  const maxOrders = Math.max(1, ...data.map((d) => d.orderCount));
  const x = (i: number) => PAD + (i / Math.max(1, data.length - 1)) * (WIDTH - PAD * 2);
  const yRevenue = (v: number) => HEIGHT - PAD - (v / maxRevenue) * (HEIGHT - PAD * 2);
  const barHeight = (count: number) => (count / maxOrders) * (HEIGHT - PAD * 2) * 0.35;
  const barWidth = (WIDTH - PAD * 2) / data.length;

  function linePath(key: "baseRevenueJpy" | "ebayRevenueJpy") {
    return data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${yRevenue(d[key])}`).join(" ");
  }

  return (
    <div className="orders-trend-chart" style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="売上推移" onMouseLeave={() => setHoverIndex(null)}>
        <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} />
        {data.map((d, i) => (
          <rect
            key={`bar-${d.date}`}
            x={x(i) - barWidth / 2 + 1}
            y={HEIGHT - PAD - barHeight(d.orderCount)}
            width={Math.max(1, barWidth - 2)}
            height={barHeight(d.orderCount)}
            fill="var(--neutral-soft)"
          />
        ))}
        <path d={linePath("baseRevenueJpy")} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={linePath("ebayRevenueJpy")} fill="none" stroke="#eb6834" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {data.map((d, i) => (
          <rect key={d.date} x={x(i) - barWidth / 2} y={0} width={barWidth} height={HEIGHT} fill="transparent" onMouseEnter={() => setHoverIndex(i)} />
        ))}
        {hoverIndex !== null && (
          <>
            <line x1={x(hoverIndex)} y1={PAD} x2={x(hoverIndex)} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hoverIndex)} cy={yRevenue(data[hoverIndex]!.baseRevenueJpy)} r={4} fill="#2a78d6" />
            <circle cx={x(hoverIndex)} cy={yRevenue(data[hoverIndex]!.ebayRevenueJpy)} r={4} fill="#eb6834" />
          </>
        )}
      </svg>

      {hoverIndex !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${(x(hoverIndex) / WIDTH) * 100}%`,
            top: `${(yRevenue(Math.max(data[hoverIndex]!.baseRevenueJpy, data[hoverIndex]!.ebayRevenueJpy)) / HEIGHT) * 100}%`,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{data[hoverIndex]!.date}</div>
          <div>
            <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE売上 {formatJpy(data[hoverIndex]!.baseRevenueJpy)}
          </div>
          <div>
            <span className="chart-legend-dot" style={{ background: "#eb6834" }} /> eBay売上 {formatJpy(data[hoverIndex]!.ebayRevenueJpy)}
          </div>
          <div>
            <span className="chart-legend-dot" style={{ background: "var(--neutral-soft)" }} /> 注文数 {data[hoverIndex]!.orderCount}件
          </div>
        </div>
      )}

      <div className="chart-legend" style={{ marginTop: "0.5rem" }}>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE売上
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#eb6834" }} /> eBay売上
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "var(--neutral-soft)" }} /> 注文数
        </span>
      </div>
    </div>
  );
}
