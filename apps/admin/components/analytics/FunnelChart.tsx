import type { Funnel } from "./types";

/** A new funnel chart. All 3 counts are real: aiListingDraft rows created in the selected
 *  range (generated), of those, how many reached channel_listings(ebay, published)
 *  (published), and of those, how many have at least one order in range (ordered). */
export function FunnelChartView({ funnel }: { funnel: Funnel }) {
  const stages = [
    { label: "AI出品下書き生成", value: funnel.generated, pct: 100 },
    { label: "公開(出品完了)", value: funnel.published, pct: funnel.generated > 0 ? Math.round((funnel.published / funnel.generated) * 1000) / 10 : 0 },
    { label: "注文(受注)", value: funnel.ordered, pct: funnel.generated > 0 ? Math.round((funnel.ordered / funnel.generated) * 1000) / 10 : 0 },
  ];
  const maxValue = Math.max(1, funnel.generated);

  return (
    <div className="funnel-chart">
      {stages.map((s, i) => {
        const widthPct = Math.max(8, (s.value / maxValue) * 100);
        return (
          <div key={s.label} className="funnel-stage">
            <div className="funnel-bar-wrap">
              <div className="funnel-bar" data-stage={i} style={{ width: `${widthPct}%` }}>
                <span className="funnel-bar-label">{s.label}</span>
                <span className="funnel-bar-value">{s.value.toLocaleString()}</span>
              </div>
            </div>
            {i > 0 && <div className="funnel-pct">{s.pct}%</div>}
          </div>
        );
      })}
    </div>
  );
}
