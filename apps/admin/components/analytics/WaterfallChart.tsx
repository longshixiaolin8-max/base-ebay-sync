import type { ProfitWaterfall } from "./types";

/** A new waterfall chart -- 売上 down through each real cost line to 営業利益. Every bar is a
 *  real figure from orders/summary-style channel-breakdown math (packages/db's orders +
 *  computeOrderProfit), not a guessed proportion. */
export function WaterfallChartView({ data, formatJpy }: { data: ProfitWaterfall; formatJpy: (jpy: number) => string }) {
  const steps = [
    { label: "売上", value: data.revenueJpy, kind: "total" as const },
    { label: "仕入原価(商品原価)", value: -data.costJpy, kind: "decrease" as const },
    { label: "販売手数料(eBay・決済等)", value: -data.feesJpy, kind: "decrease" as const },
    { label: "送料・梱包費", value: -data.shippingJpy, kind: "decrease" as const },
    { label: "営業利益", value: data.profitJpy, kind: "total" as const },
  ];

  let running = 0;
  const bars = steps.map((s, i) => {
    if (s.kind === "total" && i === 0) {
      const bar = { ...s, start: 0, end: s.value };
      running = s.value;
      return bar;
    }
    if (s.kind === "total") {
      // Final bar (営業利益) always starts from zero, drawn as its own full-height total.
      return { ...s, start: 0, end: s.value };
    }
    const start = running;
    running += s.value;
    return { ...s, start: Math.min(start, running), end: Math.max(start, running) };
  });

  const maxValue = Math.max(1, ...bars.map((b) => Math.max(b.start, b.end)));

  return (
    <div className="waterfall-chart">
      <div className="waterfall-bars">
        {bars.map((b) => {
          const heightPct = ((b.end - b.start) / maxValue) * 100;
          const bottomPct = (b.start / maxValue) * 100;
          const color = b.kind === "total" ? (b.label === "営業利益" ? "var(--success)" : "#7c5cff") : "var(--danger)";
          return (
            <div key={b.label} className="waterfall-col">
              <div className="waterfall-value" style={{ color }}>
                {b.kind === "decrease" ? "−" : ""}
                {formatJpy(Math.abs(b.value))}
              </div>
              <div className="waterfall-track">
                <div className="waterfall-bar" style={{ height: `${Math.max(1, heightPct)}%`, bottom: `${bottomPct}%`, background: color }} />
              </div>
              <div className="waterfall-label">{b.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
