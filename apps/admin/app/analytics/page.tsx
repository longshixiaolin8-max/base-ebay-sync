"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { ChartIcon, CoinIcon, RefreshIcon, ShieldIcon, SparkleIcon, TagIcon, TrendUpIcon } from "@/components/icons";
import { DonutChart } from "@/components/dashboard/DonutChart";
import { RevenueTrendChart3Series } from "@/components/analytics/RevenueTrendChart3Series";
import { StackedChannelBarChart } from "@/components/analytics/StackedChannelBarChart";
import { WaterfallChartView } from "@/components/analytics/WaterfallChart";
import { TurnoverHeatmap } from "@/components/analytics/TurnoverHeatmap";
import { InsightsPanel } from "@/components/analytics/InsightsPanel";
import { FunnelChartView } from "@/components/analytics/FunnelChart";
import { ProductRankingTable } from "@/components/analytics/ProductRankingTable";
import type { AnalyticsSummary, RankedProduct } from "@/components/analytics/types";

const DONUT_COLORS = ["--donut-a", "--donut-b", "--donut-c", "--donut-d", "--donut-e", "--donut-f", "--donut-g", "--donut-h"];

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function jpy(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function deltaText(deltaPct: number | null, unit = "%"): { text: string; up: boolean } | null {
  if (deltaPct === null) return null;
  return { text: `${deltaPct > 0 ? "+" : ""}${deltaPct}${unit}(前月比)`, up: deltaPct >= 0 };
}

export default function AnalyticsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();

  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [granularity, setGranularity] = useState<"daily" | "weekly" | "monthly">("daily");

  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [ranking, setRanking] = useState<RankedProduct[]>([]);
  const [rankingLoading, setRankingLoading] = useState(true);
  const [rankingSort, setRankingSort] = useState<"revenue" | "profit" | "orders" | "turnover">("revenue");

  const days = Math.max(7, Math.round((new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000)) + 1);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const res = await apiGet<AnalyticsSummary>(`/admin/analytics/summary?days=${days}&granularity=${granularity}`);
      setSummary(res);
    } catch (err) {
      notify(`分析データの取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setSummaryLoading(false);
    }
  }, [days, granularity, notify]);

  const loadRanking = useCallback(async () => {
    setRankingLoading(true);
    try {
      const res = await apiGet<{ products: RankedProduct[] }>(`/admin/analytics/products?days=${days}&sort=${rankingSort}&limit=10`);
      setRanking(res.products);
    } catch (err) {
      notify(`商品ランキングの取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setRankingLoading(false);
    }
  }, [days, rankingSort, notify]);

  useEffect(() => {
    if (ready) void loadSummary();
  }, [ready, loadSummary]);

  useEffect(() => {
    if (ready) void loadRanking();
  }, [ready, loadRanking]);

  const revenueDelta = summary ? deltaText(summary.kpi.monthlyRevenueJpy.deltaPct) : null;
  const profitDelta = summary ? deltaText(summary.kpi.monthlyProfitJpy.deltaPct) : null;
  const conversionDelta = summary ? deltaText(summary.kpi.ebayListingConversionRate.deltaPct, "pt") : null;
  const turnoverDelta = summary ? deltaText(summary.kpi.turnoverRate.deltaPct, "回") : null;
  const approvalDelta = summary ? deltaText(summary.kpi.aiDraftApprovalRate.deltaPct, "pt") : null;

  const categorySegments = summary?.categoryRevenue.map((c, i) => ({ label: c.category, value: c.revenueJpy, colorVar: DONUT_COLORS[i % DONUT_COLORS.length]! })) ?? [];
  const categoryTotal = categorySegments.reduce((s, c) => s + c.value, 0);

  return (
    <>
      <Topbar />
      <div className="page">
        <PageHeader
          title="分析"
          lead="売上・商品パフォーマンス・同期品質・運用のインサイトを一目で把握し、よりよい意思決定をサポートします。"
          actions={
            <div className="draft-date-range">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />〜
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} max={isoDate(new Date())} />
              <button type="button" className="secondary" onClick={() => void Promise.all([loadSummary(), loadRanking()])} disabled={summaryLoading}>
                <RefreshIcon /> 更新
              </button>
            </div>
          }
        />

        <div className="kpi-grid">
          <KpiCard icon={CoinIcon} color="green" value={summary ? jpy(summary.kpi.monthlyRevenueJpy.value ?? 0) : "..."} label="月間売上" sub={revenueDelta ? <span className={revenueDelta.up ? "kpi-trend up" : "kpi-trend down"}>{revenueDelta.up ? "↑" : "↓"} {revenueDelta.text}</span> : undefined} />
          <KpiCard icon={TrendUpIcon} color="green" value={summary ? jpy(summary.kpi.monthlyProfitJpy.value ?? 0) : "..."} label="月間利益" sub={profitDelta ? <span className={profitDelta.up ? "kpi-trend up" : "kpi-trend down"}>{profitDelta.up ? "↑" : "↓"} {profitDelta.text}</span> : undefined} />
          <KpiCard icon={TagIcon} color="orange" value={summary?.kpi.ebayListingConversionRate.value != null ? `${summary.kpi.ebayListingConversionRate.value}%` : "—"} label="eBay出品成約率" sub={conversionDelta ? <span className={conversionDelta.up ? "kpi-trend up" : "kpi-trend down"}>{conversionDelta.up ? "↑" : "↓"} {conversionDelta.text}</span> : undefined} />
          <KpiCard icon={ChartIcon} color="blue" value={summary?.kpi.turnoverRate.value != null ? `${summary.kpi.turnoverRate.value}回/月` : "—"} label="商品回転率" sub={turnoverDelta ? <span className={turnoverDelta.up ? "kpi-trend up" : "kpi-trend down"}>{turnoverDelta.up ? "↑" : "↓"} {turnoverDelta.text}</span> : undefined} />
          <KpiCard icon={ShieldIcon} color="green" value={summary ? `${summary.kpi.syncSuccessRate.value}%` : "..."} label="同期成功率" />
          <KpiCard icon={SparkleIcon} color="purple" value={summary?.kpi.aiDraftApprovalRate.value != null ? `${summary.kpi.aiDraftApprovalRate.value}%` : "—"} label="AI下書き承認率" sub={approvalDelta ? <span className={approvalDelta.up ? "kpi-trend up" : "kpi-trend down"}>{approvalDelta.up ? "↑" : "↓"} {approvalDelta.text}</span> : undefined} />
        </div>

        <div className="inventory-charts-row">
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>売上推移</h2>
            {summary && <RevenueTrendChart3Series data={summary.trend} granularity={granularity} onGranularityChange={setGranularity} formatJpy={jpy} />}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>チャネル別売上</h2>
            {summary && <StackedChannelBarChart data={summary.channelByMonth} formatJpy={jpy} />}
          </div>
        </div>

        <div className="analytics-tri-row">
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>利益構成(ウォーターフォール)</h2>
            {summary && <WaterfallChartView data={summary.profitWaterfall} formatJpy={jpy} />}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>カテゴリ別売上</h2>
            {summary && (
              <>
                <DonutChart segments={categorySegments} centerLabel="合計" centerValue={jpy(categoryTotal)} />
                {summary.categoryRevenue.length === 0 && <p className="inventory-detail-hint">この期間のカテゴリ別データがありません。</p>}
              </>
            )}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>
              在庫回転ヒートマップ<span className="section-subtitle">(過去8週間・週次販売数)</span>
            </h2>
            {summary && <TurnoverHeatmap data={summary.turnoverHeatmap} />}
          </div>
        </div>

        <div className="analytics-bottom-row">
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>運用インサイト</h2>
            {summary && <InsightsPanel insights={summary.insights} />}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>AI出品 → 公開 → 受注ファネル</h2>
            {summary && <FunnelChartView funnel={summary.funnel} />}
          </div>
        </div>

        <ProductRankingTable products={ranking} loading={rankingLoading} sort={rankingSort} onSortChange={setRankingSort} formatJpy={jpy} />
      </div>
    </>
  );
}
