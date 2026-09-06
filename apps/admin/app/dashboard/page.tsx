"use client";

import type { ProductMaster, SyncError } from "@ai-ec/core";
import Link from "next/link";
import type { ComponentType, SVGProps } from "react";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { getApiBaseUrl } from "@/lib/amplify-config";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { TrendChart } from "@/components/TrendChart";
import { AlertIcon, BoxIcon, CartIcon, ClockIcon, CoinIcon, DownloadIcon, TagIcon, TrendUpIcon } from "@/components/icons";

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

interface RecentOrder {
  id: string;
  productId: string;
  productTitle: string | null;
  sku: string | null;
  channel: string;
  revenueUsdCents: number;
  status: string;
  placedAt: string;
}

interface DashboardSummary {
  currentMonth: MonthKpi;
  previousMonth: { revenueUsdCents: number; netProfitUsdCents: number; orderCount: number };
  trend: TrendPointRaw[];
  recentOrders: RecentOrder[];
  inventory: { totalAvailable: number; lowStockCount: number };
}

interface ChannelState {
  state: "HEALTHY" | "DEGRADED" | "ISOLATED" | "RECOVERING" | "RECONCILING";
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  ORDER_RECEIVED: "受注",
  PAID: "入金済み",
  ALLOCATED: "引当済み",
  SHIPPED: "発送済み",
  DELIVERED: "完了",
  CANCELLED: "キャンセル",
  RETURN_REQUESTED: "返品申請",
  RETURNED: "返品済み",
  REFUNDED: "返金済み",
};

const ORDER_STATUS_BADGE: Record<string, string> = {
  ALLOCATED: "badge warn",
  SHIPPED: "badge warn",
  DELIVERED: "badge ok",
  RETURN_REQUESTED: "badge error",
  RETURNED: "badge error",
  REFUNDED: "badge error",
};

function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export default function DashboardPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [syncErrors, setSyncErrors] = useState<SyncError[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [baseState, setBaseState] = useState<ChannelState | null>(null);
  const [ebayState, setEbayState] = useState<ChannelState | null>(null);
  const [metric, setMetric] = useState<"revenue" | "profit">("revenue");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    Promise.all([
      apiGet<{ products: ProductMaster[] }>("/admin/products"),
      apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors"),
      apiGet<DashboardSummary>("/admin/dashboard/summary"),
      apiGet<ChannelState>("/admin/sync/state?channel=base"),
      apiGet<ChannelState>("/admin/sync/state?channel=ebay"),
    ])
      .then(([p, e, s, base, ebay]) => {
        setProducts(p.products);
        setSyncErrors(e.syncErrors);
        setSummary(s);
        setBaseState(base);
        setEbayState(ebay);
      })
      .catch((err) => notify(`ダッシュボードの取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [ready, notify]);

  const pendingApproval = products.filter((p) => p.status === "ai_generated").length;
  const active = products.filter((p) => p.status === "active").length;
  const soldOut = products.filter((p) => p.status === "sold_out").length;

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
    ];
    const csv = rows.map((r) => r.map((c) => csvEscape(c)).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dashboard-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>ダッシュボード</h1>
            <p className="page-lead">売上と在庫、今日の状況をひと目で。</p>
          </div>
          <button type="button" className="secondary" onClick={exportReport} disabled={!summary}>
            <DownloadIcon /> レポート出力
          </button>
        </div>

        {!ready || loading || !summary ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <span className="stat-card-icon blue">
                  <CoinIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{formatUsd(summary.currentMonth.revenueUsdCents)}</div>
                <div className="kpi-label">今月の売上</div>
                <div className="kpi-sub">
                  {revenueTrendPct === null ? (
                    <span>先月のデータなし</span>
                  ) : (
                    <span className={`kpi-trend ${revenueTrendPct >= 0 ? "up" : "down"}`}>
                      {revenueTrendPct >= 0 ? "▲" : "▼"} 前月比 {revenueTrendPct >= 0 ? "+" : ""}
                      {revenueTrendPct}%
                    </span>
                  )}
                </div>
              </div>
              <div className="kpi-card">
                <span className="stat-card-icon green">
                  <TrendUpIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{formatUsd(summary.currentMonth.netProfitUsdCents)}</div>
                <div className="kpi-label">今月の利益</div>
                <div className="kpi-sub">
                  利益率{" "}
                  {summary.currentMonth.profitMarginBasisPoints != null
                    ? `${(summary.currentMonth.profitMarginBasisPoints / 100).toFixed(1)}%`
                    : "—"}
                </div>
              </div>
              <div className="kpi-card">
                <span className="stat-card-icon purple">
                  <CartIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{summary.currentMonth.orderCount}件</div>
                <div className="kpi-label">今月の注文数</div>
                <div className="kpi-sub">
                  BASE {summary.currentMonth.ordersByChannel.base ?? 0}件 / eBay {summary.currentMonth.ordersByChannel.ebay ?? 0}件
                </div>
              </div>
              <div className="kpi-card">
                <span className="stat-card-icon orange">
                  <BoxIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{summary.inventory.totalAvailable}点</div>
                <div className="kpi-label">販売可能在庫</div>
                <div className="kpi-sub">
                  {summary.inventory.lowStockCount > 0 ? (
                    <span className="badge warn">在庫注意 {summary.inventory.lowStockCount}商品</span>
                  ) : (
                    <span>在庫は十分です</span>
                  )}
                </div>
              </div>
            </div>

            <div className="stat-grid" style={{ marginTop: "0.85rem" }}>
              <StatCard icon={BoxIcon} color="blue" label="商品数" value={products.length} href="/products" />
              <StatCard icon={ClockIcon} color="orange" label="承認待ち" value={pendingApproval} href="/products" />
              <StatCard icon={TagIcon} color="green" label="出品中" value={active} href="/commerce" />
              <StatCard icon={CartIcon} color="purple" label="売り切れ" value={soldOut} href="/products" />
              <StatCard
                icon={AlertIcon}
                color="red"
                label="未解決エラー"
                value={syncErrors.length}
                href="/sync-errors"
                danger={syncErrors.length > 0}
              />
            </div>

            <div className="dashboard-charts-layout" style={{ marginTop: "1.25rem" }}>
              <div className="card card-pad">
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
              </div>
              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.5rem" }}>今日の対応</h2>
                <div className="action-item">
                  <span className="action-item-icon orange">
                    <ClockIcon width={16} height={16} />
                  </span>
                  <div className="action-item-body">
                    <div className="action-item-title">承認待ちの商品</div>
                    <div className="action-item-desc">各モールへの出品前に確認してください。</div>
                  </div>
                  <span className="action-item-count">{pendingApproval}件</span>
                  <Link href="/products" className="secondary" style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem" }}>
                    確認する
                  </Link>
                </div>
                <div className="action-item">
                  <span className="action-item-icon red">
                    <AlertIcon width={16} height={16} />
                  </span>
                  <div className="action-item-body">
                    <div className="action-item-title">同期エラー</div>
                    <div className="action-item-desc">エラーの内容を確認し、対応してください。</div>
                  </div>
                  <span className="action-item-count">{syncErrors.length}件</span>
                  <Link href="/sync-errors" className="secondary" style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem" }}>
                    詳細を見る
                  </Link>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginTop: "1.25rem" }}>
              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.5rem" }}>最近の注文</h2>
                {summary.recentOrders.length === 0 ? (
                  <EmptyState>まだ注文がありません。</EmptyState>
                ) : (
                  <div className="table-wrapper">
                    <table>
                      <thead>
                        <tr>
                          <th>商品</th>
                          <th>チャネル</th>
                          <th>売上</th>
                          <th>状態</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.recentOrders.map((o) => (
                          <tr key={o.id}>
                            <td>{o.productTitle ?? o.sku ?? o.productId}</td>
                            <td>{o.channel}</td>
                            <td>{formatUsd(o.revenueUsdCents)}</td>
                            <td>
                              <span className={ORDER_STATUS_BADGE[o.status] ?? "badge"}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.5rem" }}>チャネル・同期状況</h2>
                <div className="dashboard-sync-row">
                  <span>
                    <span className={`status-dot ${baseState?.state === "HEALTHY" ? "ok" : "warn"}`} /> BASE
                  </span>
                  <span>{baseState ? (baseState.state === "HEALTHY" ? "正常" : baseState.state) : "確認中..."}</span>
                </div>
                <div className="dashboard-sync-row">
                  <span>
                    <span className={`status-dot ${ebayState?.state === "HEALTHY" ? "ok" : "warn"}`} /> eBay
                  </span>
                  <span>
                    {ebayState ? (ebayState.state === "HEALTHY" ? "正常" : ebayState.state) : "確認中..."}
                    {ebayState && ebayState.state !== "HEALTHY" && (
                      <a
                        href={`${getApiBaseUrl()}/oauth/ebay/authorize`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="reconnect-link"
                        style={{ marginLeft: "0.5rem" }}
                      >
                        再接続
                      </a>
                    )}
                  </span>
                </div>
                <Link href="/sync-errors" className="dashboard-sync-row" style={{ color: "inherit", textDecoration: "none" }}>
                  <span>過去の未解決エラー</span>
                  <span className="badge error">{syncErrors.length}件</span>
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function StatCard({
  icon: Icon,
  color,
  label,
  value,
  href,
  danger,
}: {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  color: "blue" | "orange" | "green" | "purple" | "red";
  label: string;
  value: number;
  href?: string;
  danger?: boolean;
}) {
  const content = (
    <>
      <span className={`stat-card-icon ${color}`}>
        <Icon width={18} height={18} />
      </span>
      <div className={`stat-value${danger ? " danger" : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </>
  );
  return href ? (
    <Link href={href} className="stat-card">
      {content}
    </Link>
  ) : (
    <div className="stat-card">{content}</div>
  );
}
