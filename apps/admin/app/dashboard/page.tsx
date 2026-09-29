"use client";

import type { AuditLogEntry, ChannelSyncState, ProductMaster, SyncError } from "@ai-ec/core";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { ERROR_CODE_LABEL } from "@/lib/sync-error-copy";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { TrendChart } from "@/components/TrendChart";
import { AlertIcon, BoxIcon, CoinIcon, PlugIcon, SparkleIcon, SyncIcon, TagIcon } from "@/components/icons";
import { PageHeader, SectionHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { KpiCard } from "@/components/ui/KpiCard";
import { SyncTopology } from "@/components/dashboard/SyncTopology";
import { DonutChart } from "@/components/dashboard/DonutChart";
import { AlertsPanel, type DashboardAlert } from "@/components/dashboard/AlertsPanel";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { QuickActions, type QuickAction } from "@/components/dashboard/QuickActions";
import { TaskTable, type DashboardTask } from "@/components/dashboard/TaskTable";

interface MonthKpi {
  revenueUsdCents: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints: number | null;
  orderCount: number;
  ordersByChannel: Record<string, number>;
}

interface TrendPointRaw {
  date: string;
  channelRevenueUsdCents: Record<string, number>;
  channelNetProfitUsdCents: Record<string, number>;
}

interface DashboardSummary {
  currentMonth: MonthKpi;
  previousMonth: { revenueUsdCents: number; netProfitUsdCents: number; orderCount: number };
  trend: TrendPointRaw[];
  inventory: { totalAvailable: number; lowStockCount: number };
  last24h: { revenueUsdCents: number; orderCount: number };
  ebayPublishedCount: number;
  lastSyncedAt: { base: string | null; ebay: string | null };
}

interface ChannelState {
  state: ChannelSyncState;
  reasons: string[];
}

interface SloSummary {
  syncSuccessRate: { base: { score: number }; ebay: { score: number } };
  inventoryInconsistencyCount: number;
}

const AUTH_FAILURE_HINT = "an authentication failure was recorded";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** `.dashboard-row`'s column ratio, set as a CSS custom property -- React's CSSProperties
 *  type doesn't know about arbitrary `--*` properties, hence the cast. */
function rowCols(cols: string): CSSProperties {
  return { marginTop: "1.25rem", "--row-cols": cols } as CSSProperties;
}

export default function DashboardPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [syncErrors, setSyncErrors] = useState<SyncError[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [baseState, setBaseState] = useState<ChannelState | null>(null);
  const [ebayState, setEbayState] = useState<ChannelState | null>(null);
  const [slo, setSlo] = useState<SloSummary | null>(null);
  const [activity, setActivity] = useState<AuditLogEntry[]>([]);
  const [metric, setMetric] = useState<"revenue" | "profit">("revenue");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    Promise.all([
      apiGet<{ products: ProductMaster[] }>("/admin/products"),
      apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false"),
      apiGet<DashboardSummary>("/admin/dashboard/summary"),
      apiGet<ChannelState>("/admin/sync/state?channel=base"),
      apiGet<ChannelState>("/admin/sync/state?channel=ebay"),
      apiGet<SloSummary>("/admin/slo"),
      apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log"),
    ])
      .then(([p, e, s, base, ebay, sloRes, auditRes]) => {
        setProducts(p.products);
        setSyncErrors(e.syncErrors);
        setSummary(s);
        setBaseState(base);
        setEbayState(ebay);
        setSlo(sloRes);
        setActivity(auditRes.auditLog.slice(0, 6));
      })
      .catch((err) => notify(`ダッシュボードの取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [ready, notify]);

  // The public GET /oauth/ebay/authorize route was removed (round 12 hardening); OAuth
  // connect now always starts from this authenticated admin session via the authenticated
  // GET /admin/oauth/ebay/authorize-url, which mints the signed state for this caller's own
  // tenantId server-side.
  async function reconnect(channel: "base" | "ebay") {
    try {
      const res = await apiGet<{ url: string }>(`/admin/oauth/${channel}/authorize-url`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      notify(`連携の開始に失敗しました: ${(err as Error).message}`);
    }
  }

  const pendingApproval = useMemo(() => products.filter((p) => p.status === "ai_generated").length, [products]);

  const trend = useMemo<Array<{ date: string; base: number; ebay: number }>>(
    () =>
      (summary?.trend ?? []).map((t) => {
        const channels = metric === "revenue" ? t.channelRevenueUsdCents : t.channelNetProfitUsdCents;
        return { date: t.date, base: channels.base ?? 0, ebay: channels.ebay ?? 0 };
      }),
    [summary, metric],
  );
  const hasTrendData = trend.some((t) => t.base !== 0 || t.ebay !== 0);

  const revenueTrendPct =
    summary && summary.previousMonth.revenueUsdCents > 0
      ? Math.round(
          ((summary.currentMonth.revenueUsdCents - summary.previousMonth.revenueUsdCents) / summary.previousMonth.revenueUsdCents) * 1000,
        ) / 10
      : null;

  const syncSuccessRatePct = slo ? Math.round((slo.syncSuccessRate.base.score + slo.syncSuccessRate.ebay.score) / 2) : null;

  const alerts = useMemo<DashboardAlert[]>(() => {
    const list: DashboardAlert[] = [];
    for (const [channel, state] of [
      ["base", baseState],
      ["ebay", ebayState],
    ] as const) {
      if (!state || state.state === "HEALTHY") continue;
      const authIssue = state.reasons.some((r) => r.includes(AUTH_FAILURE_HINT));
      list.push({
        id: `channel-${channel}`,
        tone: state.state === "ISOLATED" ? "error" : "warn",
        title: authIssue
          ? `${channel === "base" ? "BASE" : "eBay"}の連携に認証エラーが発生しています`
          : `${channel === "base" ? "BASE" : "eBay"}の同期状態が「${state.state}」です`,
        description: state.reasons[0] ?? "詳細はチャネル同期の状況を確認してください。",
        actionLabel: authIssue ? "再接続する" : "詳細を見る",
        actionHref: authIssue ? undefined : "/sync-errors",
        onAction: authIssue ? () => reconnect(channel) : undefined,
      });
    }
    if (slo && slo.inventoryInconsistencyCount > 0) {
      list.push({
        id: "inventory-drift",
        tone: "warn",
        title: `在庫差分が${slo.inventoryInconsistencyCount}件あります`,
        description: "BASEとeBayで在庫数が異なる商品があります。早めにご確認ください。",
        actionLabel: "在庫差分を確認",
        actionHref: "/sync-errors",
      });
    }
    if (pendingApproval > 0) {
      list.push({
        id: "ai-drafts",
        tone: "warn",
        title: `AI出品下書きが${pendingApproval}件あります`,
        description: "生成された出品下書きを確認し、公開してください。",
        actionLabel: "下書きを確認",
        actionHref: "/drafts",
      });
    }
    return list;
  }, [baseState, ebayState, slo, pendingApproval]);

  const donutSegments = useMemo(() => {
    const byChannel = summary?.currentMonth.ordersByChannel ?? {};
    const base = byChannel.base ?? 0;
    const ebay = byChannel.ebay ?? 0;
    const other = Object.entries(byChannel)
      .filter(([ch]) => ch !== "base" && ch !== "ebay")
      .reduce((sum, [, n]) => sum + n, 0);
    return [
      { label: "eBay", value: ebay, colorVar: "--donut-a" },
      { label: "BASE", value: base, colorVar: "--donut-b" },
      { label: "その他", value: other, colorVar: "--donut-c" },
    ];
  }, [summary]);
  const donutTotal = donutSegments.reduce((sum, s) => sum + s.value, 0);

  const quickActions: QuickAction[] = [
    { id: "review", icon: SparkleIcon, title: "新規出品レビュー", desc: "AIで生成された下書きを確認", href: "/drafts", primary: true },
    { id: "inventory", icon: BoxIcon, title: "在庫差分を確認", desc: "在庫情報の食い違いを確認・同期", href: "/sync-errors" },
    { id: "ebay", icon: PlugIcon, title: "eBay接続確認", desc: "接続状態の確認・再認証", onClick: () => reconnect("ebay") },
    { id: "billing", icon: CoinIcon, title: "請求状況確認", desc: "ご利用プラン・請求履歴", href: "/billing" },
  ];

  const tasks = useMemo<DashboardTask[]>(() => {
    const fromErrors: DashboardTask[] = syncErrors.map((e) => {
      const copy = ERROR_CODE_LABEL[e.errorCode];
      const high = e.errorCode === "possible_double_sale" || e.errorCode === "inventory_drift";
      return {
        id: `err-${e.id}`,
        typeLabel: copy?.title ?? e.errorCode,
        typeTone: high ? "error" : "warn",
        title: e.productId ? `商品ID ${e.productId.slice(0, 8)}` : (e.channel ?? "プラットフォーム"),
        detail: copy?.summary ?? e.errorMessage,
        priority: high ? "high" : "medium",
        statusLabel: "対応待ち",
        statusTone: "warn",
        createdAt: e.createdAt.toString(),
        actionLabel: "詳細を見る",
        actionHref: "/sync-errors",
      };
    });
    const fromDrafts: DashboardTask[] = products
      .filter((p) => p.status === "ai_generated")
      .slice(0, 5)
      .map((p) => ({
        id: `draft-${p.id}`,
        typeLabel: "AI下書き",
        typeTone: "ai",
        title: p.title,
        sku: p.sku,
        detail: "AIが生成した出品下書きがあります。内容を確認してください。",
        priority: "medium",
        statusLabel: "レビュー待ち",
        statusTone: "info",
        createdAt: p.updatedAt.toString(),
        actionLabel: "確認する",
        actionHref: "/drafts",
      }));
    return [...fromErrors, ...fromDrafts].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 8);
  }, [syncErrors, products]);

  function exportReport() {
    if (!summary) return;
    const rows = [
      ["項目", "値"],
      ["今月の売上", formatUsd(summary.currentMonth.revenueUsdCents)],
      ["今月の利益", formatUsd(summary.currentMonth.netProfitUsdCents)],
      [
        "利益率",
        summary.currentMonth.profitMarginBasisPoints != null ? `${(summary.currentMonth.profitMarginBasisPoints / 100).toFixed(1)}%` : "-",
      ],
      ["注文数", String(summary.currentMonth.orderCount)],
      ["BASE注文数", String(summary.currentMonth.ordersByChannel.base ?? 0)],
      ["eBay注文数", String(summary.currentMonth.ordersByChannel.ebay ?? 0)],
      ["販売可能在庫", String(summary.inventory.totalAvailable)],
      ["在庫注意商品数", String(summary.inventory.lowStockCount)],
      ["公開中eBay出品数", String(summary.ebayPublishedCount)],
    ];
    const csv = rows.map((r) => r.map((c) => csvEscape(c)).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Topbar searchPlaceholder="商品・注文・SKUなどを検索..." />
      <div className="page page-wide">
        <PageHeader
          title="ダッシュボード"
          lead="BASEとeBayの商品・在庫・注文を一元管理。今日の状況をひと目で。"
          actions={
            <button type="button" className="secondary" onClick={exportReport} disabled={!summary}>
              レポート出力
            </button>
          }
        />

        {!ready || loading || !summary || !slo ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            {products.length === 0 && (
              <div className="auth-callout" style={{ marginBottom: "1rem" }}>
                <span>
                  まだ商品が同期されていません。BASEの商品は自動で取り込まれます(最短15分ごと)。
                </span>
              </div>
            )}

            <div className="kpi-grid">
              <KpiCard icon={BoxIcon} color="blue" value={products.length.toLocaleString()} label="総商品数" />
              <KpiCard icon={TagIcon} color="green" value={summary.ebayPublishedCount.toLocaleString()} label="公開中eBay出品数" />
              <KpiCard
                icon={AlertIcon}
                color="red"
                value={syncErrors.length}
                label="要確認エラー"
                href="/sync-errors"
                sub={syncErrors.length > 0 ? <span className="kpi-trend down">対応が必要です</span> : <span>解決済み</span>}
              />
              <KpiCard
                icon={CoinIcon}
                color="orange"
                value={formatUsd(summary.last24h.revenueUsdCents)}
                label="24時間売上"
                sub={
                  revenueTrendPct === null ? undefined : (
                    <span className={`kpi-trend ${revenueTrendPct >= 0 ? "up" : "down"}`}>
                      {revenueTrendPct >= 0 ? "▲" : "▼"} 前月比 {revenueTrendPct >= 0 ? "+" : ""}
                      {revenueTrendPct}%
                    </span>
                  )
                }
              />
              <KpiCard icon={SyncIcon} color="purple" value={`${syncSuccessRatePct}%`} label="同期成功率" />
              <KpiCard
                icon={BoxIcon}
                color={slo.inventoryInconsistencyCount > 0 ? "red" : "green"}
                value={slo.inventoryInconsistencyCount}
                label="在庫差分件数"
                href="/sync-errors"
              />
            </div>

            <Card style={{ marginTop: "1.25rem" }}>
              <SectionHeader
                title="同期ステータス"
                action={
                  <a href="/sync-errors" className="section-header-action">
                    詳細を見る
                  </a>
                }
              />
              <SyncTopology
                baseState={baseState?.state ?? null}
                ebayState={ebayState?.state ?? null}
                productCount={products.length}
                totalAvailable={summary.inventory.totalAvailable}
                ebayPublishedCount={summary.ebayPublishedCount}
                lastSyncedAt={summary.lastSyncedAt}
              />
            </Card>

            <div className="dashboard-row" style={rowCols("1.6fr 1fr 1fr")}>
              <Card>
                <div className="chart-card-header">
                  <h2>売上・利益の推移</h2>
                  <div className="filter-tabs">
                    <button type="button" className="filter-tab" data-active={metric === "revenue"} onClick={() => setMetric("revenue")}>
                      売上
                    </button>
                    <button type="button" className="filter-tab" data-active={metric === "profit"} onClick={() => setMetric("profit")}>
                      利益
                    </button>
                  </div>
                </div>
                {hasTrendData ? (
                  <TrendChart data={trend} formatValue={formatUsd} />
                ) : (
                  <div className="chart-empty">直近14日間の注文データがありません。</div>
                )}
              </Card>
              <Card>
                <SectionHeader title="チャネル別注文数" />
                {donutTotal > 0 ? (
                  <DonutChart segments={donutSegments} centerLabel="合計" centerValue={`${donutTotal}`} />
                ) : (
                  <div className="chart-empty">今月の注文がありません。</div>
                )}
              </Card>
              <Card>
                <SectionHeader title="クイックアクション" />
                <QuickActions actions={quickActions} />
              </Card>
            </div>

            <div className="dashboard-row" style={rowCols("1.6fr 1fr")}>
              <Card>
                <SectionHeader title="対応が必要なタスク" />
                <TaskTable tasks={tasks} />
              </Card>
              <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
                <Card>
                  <SectionHeader title="重要なお知らせ" />
                  <AlertsPanel alerts={alerts} />
                </Card>
                <Card>
                  <SectionHeader
                    title="最近のアクティビティ"
                    action={
                      <a href="/audit-log" className="section-header-action">
                        すべて見る
                      </a>
                    }
                  />
                  <ActivityFeed entries={activity} />
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
