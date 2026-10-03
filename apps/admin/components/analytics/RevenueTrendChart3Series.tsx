import { useState } from "react";
import { Tabs } from "@/components/ui/Tabs";
import type { TrendPoint } from "./types";

const WIDTH = 720;
const HEIGHT = 240;
const PAD = 36;

/**
 * A new 3-series line chart (合計/eBay/BASE) with a granularity toggle -- TrendChart.tsx is
 * hardcoded to exactly 2 series (base/ebay), so this is a fresh component rather than a
 * generalization of it (same reasoning already applied to InventoryTrendChart and
 * orders/RevenueTrendChart in earlier rounds of this page set).
 */
export function RevenueTrendChart3Series({
  data,
  granularity,
  onGranularityChange,
  formatJpy,
}: {
  data: TrendPoint[];
  granularity: "daily" | "weekly" | "monthly";
  onGranularityChange: (g: "daily" | "weekly" | "monthly") => void;
  formatJpy: (jpy: number) => string;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const maxValue = Math.max(1, ...data.map((d) => Math.max(d.totalRevenueJpy, d.ebayRevenueJpy, d.baseRevenueJpy)));
  const x = (i: number) => PAD + (i / Math.max(1, data.length - 1)) * (WIDTH - PAD * 2);
  const y = (v: number) => HEIGHT - PAD - (v / maxValue) * (HEIGHT - PAD * 2);
  const tickEvery = Math.max(1, Math.ceil(data.length / 8));

  function linePath(key: "totalRevenueJpy" | "ebayRevenueJpy" | "baseRevenueJpy") {
    return data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d[key])}`).join(" ");
  }

  return (
    <div>
      <div className="analytics-chart-header">
        <Tabs
          tabs={[
            { id: "daily", label: "日次" },
            { id: "weekly", label: "週次" },
            { id: "monthly", label: "月次" },
          ]}
          active={granularity}
          onChange={(id) => onGranularityChange(id as typeof granularity)}
        />
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" role="img" aria-label="売上推移" onMouseLeave={() => setHoverIndex(null)}>
          <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} />
          {data.map((d, i) =>
            i % tickEvery === 0 ? (
              <text key={d.period} x={x(i)} y={HEIGHT - PAD + 14} textAnchor="middle" fontSize={9} fill="var(--fg-subtle)">
                {d.period.length > 7 ? d.period.slice(5) : d.period}
              </text>
            ) : null,
          )}
          <path d={linePath("totalRevenueJpy")} fill="none" stroke="#7c5cff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
          <path d={linePath("ebayRevenueJpy")} fill="none" stroke="#3aa876" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          <path d={linePath("baseRevenueJpy")} fill="none" stroke="#2a78d6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {data.map((d, i) => (
            <rect key={d.period} x={x(i) - (WIDTH - PAD * 2) / data.length / 2} y={0} width={(WIDTH - PAD * 2) / data.length} height={HEIGHT} fill="transparent" onMouseEnter={() => setHoverIndex(i)} />
          ))}
          {hoverIndex !== null && (
            <>
              <line x1={x(hoverIndex)} y1={PAD} x2={x(hoverIndex)} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
              <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.totalRevenueJpy)} r={4} fill="#7c5cff" />
              <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.ebayRevenueJpy)} r={4} fill="#3aa876" />
              <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.baseRevenueJpy)} r={4} fill="#2a78d6" />
            </>
          )}
        </svg>
        {hoverIndex !== null && (
          <div
            className="chart-tooltip"
            style={{
              left: `${(x(hoverIndex) / WIDTH) * 100}%`,
              top: `${(y(data[hoverIndex]!.totalRevenueJpy) / HEIGHT) * 100}%`,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 2 }}>{data[hoverIndex]!.period}</div>
            <div>
              <span className="chart-legend-dot" style={{ background: "#7c5cff" }} /> 合計 {formatJpy(data[hoverIndex]!.totalRevenueJpy)}
            </div>
            <div>
              <span className="chart-legend-dot" style={{ background: "#3aa876" }} /> eBay {formatJpy(data[hoverIndex]!.ebayRevenueJpy)}
            </div>
            <div>
              <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE {formatJpy(data[hoverIndex]!.baseRevenueJpy)}
            </div>
          </div>
        )}
      </div>
      <div className="chart-legend" style={{ marginTop: "0.5rem" }}>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#7c5cff" }} /> 合計
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#3aa876" }} /> eBay
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "#2a78d6" }} /> BASE
        </span>
      </div>
    </div>
  );
}
