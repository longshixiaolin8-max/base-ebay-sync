"use client";

import { useState } from "react";

export interface TrendPoint {
  date: string;
  base: number;
  ebay: number;
}

interface TrendChartProps {
  data: TrendPoint[];
  formatValue: (value: number) => string;
}

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;

/**
 * Two fixed categorical slots from this app's validated palette (dataviz skill,
 * references/palette.md) -- blue for BASE, orange for eBay -- assigned by channel
 * identity, never re-cycled, with light/dark steps swapped via the theme's own scopes.
 */
export function TrendChart({ data, formatValue }: TrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const maxValue = Math.max(1, ...data.map((d) => Math.max(d.base, d.ebay)));

  const x = (i: number) => PAD_LEFT + (data.length <= 1 ? 0 : (i / (data.length - 1)) * plotWidth);
  const y = (v: number) => PAD_TOP + plotHeight - (v / maxValue) * plotHeight;

  const linePath = (key: "base" | "ebay") =>
    data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(" ");

  const gridLines = [0, 0.5, 1];
  const tickEvery = Math.ceil(data.length / 7);

  return (
    <div className="viz-root" style={{ position: "relative" }}>
      <style>{`
        .viz-root {
          --series-base: #2a78d6;
          --series-ebay: #eb6834;
          --grid-line: var(--border);
          --axis-text: var(--fg-subtle);
        }
        :root:not([data-theme="light"]) .viz-root {
          --series-base: #3987e5;
          --series-ebay: #d95926;
        }
        :root[data-theme="dark"] .viz-root {
          --series-base: #3987e5;
          --series-ebay: #d95926;
        }
      `}</style>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseLeave={() => setHoverIndex(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * WIDTH;
          const idx = Math.round(((relX - PAD_LEFT) / plotWidth) * (data.length - 1));
          setHoverIndex(Math.min(data.length - 1, Math.max(0, idx)));
        }}
      >
        {gridLines.map((g) => (
          <line
            key={g}
            x1={PAD_LEFT}
            x2={WIDTH - PAD_RIGHT}
            y1={PAD_TOP + plotHeight * (1 - g)}
            y2={PAD_TOP + plotHeight * (1 - g)}
            stroke="var(--grid-line)"
            strokeWidth={1}
          />
        ))}
        {gridLines.map((g) => (
          <text
            key={g}
            x={PAD_LEFT - 8}
            y={PAD_TOP + plotHeight * (1 - g) + 4}
            textAnchor="end"
            fontSize={10}
            fill="var(--axis-text)"
          >
            {formatValue(maxValue * g)}
          </text>
        ))}
        {data.map((d, i) =>
          i % tickEvery === 0 ? (
            <text key={d.date} x={x(i)} y={HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--axis-text)">
              {d.date.slice(5).replace("-", "/")}
            </text>
          ) : null,
        )}
        <path d={linePath("base")} fill="none" stroke="var(--series-base)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={linePath("ebay")} fill="none" stroke="var(--series-ebay)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hoverIndex !== null && (
          <line x1={x(hoverIndex)} x2={x(hoverIndex)} y1={PAD_TOP} y2={PAD_TOP + plotHeight} stroke="var(--grid-line)" strokeWidth={1} />
        )}
        {hoverIndex !== null && (
          <>
            <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.base)} r={4} fill="var(--series-base)" />
            <circle cx={x(hoverIndex)} cy={y(data[hoverIndex]!.ebay)} r={4} fill="var(--series-ebay)" />
          </>
        )}
      </svg>
      {hoverIndex !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${(x(hoverIndex) / WIDTH) * 100}%`,
            top: `${(y(Math.max(data[hoverIndex]!.base, data[hoverIndex]!.ebay)) / HEIGHT) * 100}%`,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{data[hoverIndex]!.date}</div>
          <div>
            <span className="chart-legend-dot" style={{ background: "var(--series-base)" }} /> BASE {formatValue(data[hoverIndex]!.base)}
          </div>
          <div>
            <span className="chart-legend-dot" style={{ background: "var(--series-ebay)" }} /> eBay {formatValue(data[hoverIndex]!.ebay)}
          </div>
        </div>
      )}
      <div className="chart-legend" style={{ marginTop: "0.5rem" }}>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "var(--series-base)" }} /> BASE
        </span>
        <span className="chart-legend-item">
          <span className="chart-legend-dot" style={{ background: "var(--series-ebay)" }} /> eBay
        </span>
      </div>
    </div>
  );
}
