import { EmptyState } from "@/components/Skeleton";
import type { TurnoverHeatmapData } from "./types";

/**
 * A new heatmap table. Cells are real weekly units-sold counts per category (see this page's
 * lib/analytics-copy.ts and the API route's own header comment for why this isn't a literal
 * "turnover rate" -- that would need a per-category current-inventory denominator this route
 * doesn't compute).
 */
export function TurnoverHeatmap({ data }: { data: TurnoverHeatmapData }) {
  if (data.categories.length === 0) {
    return <EmptyState>この期間はカテゴリ別の販売データがありません。</EmptyState>;
  }

  const maxCell = Math.max(1, ...data.cells.flat());

  function cellColor(value: number): string {
    if (value === 0) return "var(--neutral-soft)";
    const intensity = Math.min(1, value / maxCell);
    return `color-mix(in srgb, var(--accent) ${Math.round(intensity * 80 + 10)}%, var(--surface))`;
  }

  return (
    <div className="table-wrapper">
      <table className="heatmap-table">
        <thead>
          <tr>
            <th>週</th>
            {data.categories.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.weeks.map((week, wi) => (
            <tr key={week}>
              <td className="heatmap-week-label">{week}</td>
              {data.categories.map((c, ci) => {
                const value = data.cells[ci]?.[wi] ?? 0;
                return (
                  <td key={c} className="heatmap-cell" style={{ background: cellColor(value) }} title={`${week} / ${c}: ${value}件`}>
                    {value}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
