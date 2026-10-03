import { useState } from "react";
import type { InventoryTrendPoint } from "./types";

const WIDTH = 640;
const HEIGHT = 220;
const PAD = 32;

/**
 * A new, small, purpose-built line chart rather than reusing apps/admin/components/TrendChart
 * -- that component's series are hardcoded to "base"/"ebay" (field names, CSS var names, and
 * legend text all literally say BASE/eBay), and it's already used elsewhere, so generalizing
 * it here would risk that existing caller. Same hand-rolled-SVG, no-library approach.
 */
export function InventoryTrendChart({ data }: { data: InventoryTrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (data.length === 0) return null;

  const maxValue = Math.max(1, ...data.map((d) => Math.max(d.diffCount, d.possibleDoubleSaleCount)));
  const x = (i: number) => PAD + (i / Math.max(1, data.length - 1)) * (WIDTH - PAD * 2);
  const y = (v: number) => HEIGHT - PAD - (v / maxValue) * (HEIGHT - PAD * 2);

  function linePath(key: "diffCount" | "possibleDoubleSaleCount") {
    return data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d[key])}`).join(" ");
  }

  return (
    <div className="inventory-trend-chart" style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        width="100%"
        role="img"
        aria-label="在庫差分とpossible_double_saleの7日間推移"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} />
        <path d={linePath("diffCount")} fill="none" stroke="var(--warn)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={linePath("possibleDoubleSaleCount")} fill="none" stroke="var(--danger)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {data.map((d, i) => (
          <rect
            key={d.date}
            x={x(i) - (WIDTH - PAD * 2) / data.length / 2}
            y={0}
            width={(WIDTH - PAD * 2) / data.length}
            height={HEIGHT}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}
        {hoverIndex !== null && (
          <>
            <line x1={x(hoverIndex)} y1={PAD} x2={x(hoverIndex)} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
            <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.diffCount)} r={4} fill="var(--warn)" />
            <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.possibleDoubleSaleCount)} r={4} fill="var(--danger)" />
          </>
        )}
      </svg>

      {hoverIndex !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${(x(hoverIndex) / WIDTH) * 100}%`,
            top: `${(y(Math.max(data[hoverIndex]!.diffCount, data[hoverIndex]!.possibleDoubleSaleCount)) / HEIGHT) * 100}%`,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{data[hoverIndex]!.date}</div>
          <div>
            <span className="chart-legend-dot" style={{ background: "var(--warn)" }} /> 在庫差分 {data[hoverIndex]!.diffCount}
          </div>
          <div>
            <span className="chart-legend-dot" style={{ background: "var(--danger)" }} /> possible_double_sale {data[hoverIndex]!.possibleDoubleSaleCount}
          </div>
        </div>
      )}
      <div className="chart-legend" style={{ marginTop: "0.5rem" }}>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "var(--warn)" }} /> 在庫差分
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "var(--danger)" }} /> possible_double_sale
        </span>
      </div>
    </div>
  );
}
