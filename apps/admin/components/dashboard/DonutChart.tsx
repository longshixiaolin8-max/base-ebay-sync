"use client";

export interface DonutSegment {
  label: string;
  value: number;
  /** One of the CSS custom properties DonutChart itself defines (--donut-a/-b/-c/...). */
  colorVar: string;
}

interface DonutChartProps {
  segments: DonutSegment[];
  centerLabel: string;
  centerValue: string;
}

const SIZE = 160;
const STROKE = 22;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Hand-rolled SVG donut (same no-chart-library approach as TrendChart) built from stacked
 * `stroke-dasharray` arcs on concentric circles of the same radius -- no external chart
 * library, consistent with this app's existing pattern.
 */
export function DonutChart({ segments, centerLabel, centerValue }: DonutChartProps) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;

  return (
    <div className="donut-chart-root">
      <style>{`
        .donut-chart-root {
          --donut-a: #315ef5;
          --donut-b: #16a34a;
          --donut-c: #8a919e;
          --donut-d: #d97706;
        }
        :root:not([data-theme="light"]) .donut-chart-root {
          --donut-a: #5b8def;
          --donut-b: #4ade80;
          --donut-c: #767c88;
          --donut-d: #f2b53d;
        }
        :root[data-theme="dark"] .donut-chart-root {
          --donut-a: #5b8def;
          --donut-b: #4ade80;
          --donut-c: #767c88;
          --donut-d: #f2b53d;
        }
      `}</style>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={`${centerLabel} ${centerValue}`}>
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" stroke="var(--border)" strokeWidth={STROKE} />
        {total > 0 &&
          segments
            .filter((s) => s.value > 0)
            .map((s) => {
              const fraction = s.value / total;
              const dash = fraction * CIRCUMFERENCE;
              const el = (
                <circle
                  key={s.label}
                  cx={SIZE / 2}
                  cy={SIZE / 2}
                  r={RADIUS}
                  fill="none"
                  stroke={`var(${s.colorVar})`}
                  strokeWidth={STROKE}
                  strokeDasharray={`${dash} ${CIRCUMFERENCE - dash}`}
                  strokeDashoffset={-offset}
                  transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
                  strokeLinecap="butt"
                />
              );
              offset += dash;
              return el;
            })}
        <text x={SIZE / 2} y={SIZE / 2 - 6} textAnchor="middle" fontSize={12} fill="var(--fg-subtle)">
          {centerLabel}
        </text>
        <text x={SIZE / 2} y={SIZE / 2 + 16} textAnchor="middle" fontSize={20} fontWeight={800} fill="var(--fg)">
          {centerValue}
        </text>
      </svg>
      <div className="donut-chart-legend">
        {segments.map((s) => (
          <div key={s.label} className="donut-chart-legend-item">
            <span className="chart-legend-dot" style={{ background: `var(${s.colorVar})` }} />
            <span className="donut-chart-legend-label">{s.label}</span>
            <span className="donut-chart-legend-value">
              {s.value.toLocaleString()} ({total > 0 ? Math.round((s.value / total) * 1000) / 10 : 0}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
