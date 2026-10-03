import type { ChannelHealthBucket } from "./types";

// --success/--warn/--danger are this app's existing semantic tokens (globals.css). "safety
// stock" and "売り切れ" have no such token yet (blue=info per the design system's color
// convention, gray=inactive) -- defined locally here the same way TrendChart/DonutChart
// define their own chart-only colors rather than adding app-wide tokens for a single chart.
const SEGMENTS: Array<{ key: keyof ChannelHealthBucket; label: string; colorVar: string }> = [
  { key: "normal", label: "正常", colorVar: "var(--success)" },
  { key: "safetyStock", label: "safety stock", colorVar: "#3b82f6" },
  { key: "drift", label: "在庫差分", colorVar: "var(--warn)" },
  { key: "possibleDoubleSale", label: "possible_double_sale", colorVar: "var(--danger)" },
  { key: "soldOut", label: "売り切れ", colorVar: "#9ca3af" },
];

interface InventoryHealthBarProps {
  rows: Array<{ label: string; bucket: ChannelHealthBucket }>;
}

/** Hand-rolled stacked horizontal bar, same no-library/CSS-custom-property approach as
 *  DonutChart/TrendChart -- no stacked-bar component existed anywhere in this repo yet. */
export function InventoryHealthBar({ rows }: InventoryHealthBarProps) {
  return (
    <div className="inventory-health-bar">
      <div className="inventory-health-legend">
        {SEGMENTS.map((s) => (
          <span key={s.key} className="inventory-health-legend-item">
            <span className="inventory-health-swatch" style={{ background: s.colorVar }} />
            {s.label}
          </span>
        ))}
      </div>
      {rows.map(({ label, bucket }) => (
        <div key={label} className="inventory-health-row">
          <div className="inventory-health-row-label">{label}</div>
          <div className="inventory-health-row-bar" role="img" aria-label={`${label}: ${SEGMENTS.map((s) => `${s.label} ${bucket[s.key]}件`).join(", ")}`}>
            {SEGMENTS.map((s) => {
              const pct = bucket.total > 0 ? (bucket[s.key] / bucket.total) * 100 : 0;
              if (pct <= 0) return null;
              return <div key={s.key} className="inventory-health-segment" style={{ width: `${pct}%`, background: s.colorVar }} title={`${s.label}: ${bucket[s.key]}件`} />;
            })}
          </div>
          <div className="inventory-health-row-total">計 {bucket.total.toLocaleString()}</div>
        </div>
      ))}
    </div>
  );
}
