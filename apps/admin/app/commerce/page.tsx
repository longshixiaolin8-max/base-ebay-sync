"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { getApiBaseUrl } from "@/lib/amplify-config";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import {
  AlertIcon,
  BoxIcon,
  CartIcon,
  CheckIcon,
  ClockIcon,
  DownloadIcon,
  RefreshIcon,
  TagIcon,
} from "@/components/icons";

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

interface SnsStatus {
  videoCreated: boolean;
  instagramPosted: boolean;
  tiktokPosted: boolean;
  scriptText: string | null;
}

interface CommerceRow {
  productId: string;
  sku: string;
  title: string;
  status: string;
  images: string[];
  channelStatus: Record<string, string>;
  lastSyncedAt: Record<string, string | null>;
  inventory: InventoryBreakdown | null;
  revenueUsdCents: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints: number | null;
  daysListed: number;
  daysToFirstSale: number | null;
  staleLevel: "fresh" | "stale_30" | "stale_60" | "stale_90";
  latestOrderStatus: string | null;
  hasReturn: boolean;
  snsStatus: SnsStatus | null;
}

interface ChannelSyncState {
  channel: string;
  state: "HEALTHY" | "DEGRADED" | "ISOLATED" | "RECOVERING" | "RECONCILING";
  reasons: string[];
}

interface DynamicPrice {
  recommendedPriceUsd: number;
  /** True profit margin (profit / price paid), NOT the cost-plus markup the merchant set as
   *  a target -- see packages/core/src/pricing.ts's DynamicPriceResult doc comment. Not yet
   *  rendered in this UI; kept typed here for the next round that surfaces it. */
  netMarginRatio: number;
  costMarkupRatio: number;
}

const STALE_BADGE: Record<CommerceRow["staleLevel"], string> = {
  fresh: "badge ok",
  stale_30: "badge warn",
  stale_60: "badge warn",
  stale_90: "badge error",
};

const STALE_LABEL: Record<CommerceRow["staleLevel"], string> = {
  fresh: "新鮮",
  stale_30: "30日超",
  stale_60: "60日超",
  stale_90: "90日超",
};

const CHANNEL_STATUS_BADGE: Record<string, string> = {
  published: "badge ok",
  pending: "badge",
  pending_approval: "badge warn",
  update_pending: "badge warn",
  error: "badge error",
  delisted: "badge",
};

const AUDIT_ACTION_LABEL: Record<string, string> = {
  ebay_listing_published: "eBayへ出品しました",
  ebay_listing_publish_approved: "eBay出品を承認しました",
  ai_draft_condition_corrected: "AI下書きのコンディションを修正しました",
  sync_error_retried: "同期エラーを再試行しました",
  ebay_listing_linked: "eBay出品を紐付けしました",
  order_status_changed: "注文状態を更新しました",
  order_profit_finalized: "利益を確定しました",
  sns_script_generated: "SNS台本を生成しました",
  sns_status_updated: "SNS状況を更新しました",
  inventory_reconstructed: "在庫を再構築しました",
  auto_rollback_applied: "自動ロールバックを適用しました",
  anomaly_detected_sync_paused: "異常検知により同期を一時停止しました",
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pct(basisPoints: number | null): string {
  return basisPoints === null ? "—" : `${(basisPoints / 100).toFixed(1)}%`;
}

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function CommercePage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [rows, setRows] = useState<CommerceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"all" | "pending" | "active" | "lowstock">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dynamicPrice, setDynamicPrice] = useState<DynamicPrice | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);
  const [baseState, setBaseState] = useState<ChannelSyncState | null>(null);
  const [ebayState, setEbayState] = useState<ChannelSyncState | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const [recentAudit, setRecentAudit] = useState<AuditLogEntry[]>([]);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ products: CommerceRow[] }>("/admin/commerce-dashboard");
      setRows(res.products);
    } catch (err) {
      notify(`コマース統合ビューの取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!ready) return;
    void load();
    apiGet<ChannelSyncState>("/admin/sync/state?channel=base").then(setBaseState).catch(() => {});
    apiGet<ChannelSyncState>("/admin/sync/state?channel=ebay").then(setEbayState).catch(() => {});
    apiGet<{ syncErrors: unknown[] }>("/admin/sync-errors?resolved=false")
      .then((res) => setErrorCount(res.syncErrors.length))
      .catch(() => {});
    apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log")
      .then((res) => setRecentAudit(res.auditLog.slice(0, 5)))
      .catch(() => {});
  }, [ready]);

  async function selectRow(row: CommerceRow) {
    setSelectedId(row.productId);
    setDynamicPrice(null);
    setPriceLoading(true);
    try {
      const price = await apiGet<DynamicPrice>(`/admin/products/${row.productId}/dynamic-price`);
      setDynamicPrice(price);
    } catch {
      // A preview-only calculation -- silently leave it blank rather than a toast for
      // every row click; the detail panel already renders a "—" fallback.
    } finally {
      setPriceLoading(false);
    }
  }

  async function generateSuggestion(productId: string) {
    setBusyId(productId);
    try {
      const res = await apiPost<{ suggestion: string; suggestedActions: string[] }>(
        `/admin/products/${productId}/stale-suggestion`,
      );
      setSuggestions((prev) => ({
        ...prev,
        [productId]: [res.suggestion, ...res.suggestedActions.map((a) => `・${a}`)].join("\n"),
      }));
    } catch (err) {
      notify(`AI提案の生成に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function generateSnsScript(productId: string) {
    setBusyId(productId);
    try {
      await apiPost(`/admin/products/${productId}/sns/script`);
      notify("SNS台本を生成しました。", "success");
      await load();
    } catch (err) {
      notify(`SNS台本の生成に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const header = ["SKU", "商品名", "BASE状態", "eBay状態", "手持在庫", "販売可能", "売上", "純利益", "滞留状態"];
    const lines = filtered.map((r) =>
      [
        r.sku,
        r.title,
        r.channelStatus.base ?? "",
        r.channelStatus.ebay ?? "",
        r.inventory?.onHand ?? "",
        r.inventory?.available ?? "",
        (r.revenueUsdCents / 100).toFixed(2),
        (r.netProfitUsdCents / 100).toFixed(2),
        STALE_LABEL[r.staleLevel],
      ]
        .map(csvEscape)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `commerce-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const pendingCount = rows.filter((r) => r.status === "ai_generated").length;
  const activeCount = rows.filter((r) => r.status === "active").length;
  const soldOutCount = rows.filter((r) => r.status === "sold_out").length;
  const lowStockRows = rows.filter((r) => r.inventory && r.inventory.available <= r.inventory.safetyBuffer);

  const filtered = useMemo(() => {
    let list = rows;
    if (tab === "pending") list = list.filter((r) => r.status === "ai_generated");
    else if (tab === "active") list = list.filter((r) => r.status === "active");
    else if (tab === "lowstock") list = list.filter((r) => r.inventory && r.inventory.available <= r.inventory.safetyBuffer);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((r) => r.title.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q));
    }
    return list;
  }, [rows, tab, query]);

  const selectedRow = rows.find((r) => r.productId === selectedId) ?? null;

  const bothHealthy = baseState?.state === "HEALTHY" && ebayState?.state === "HEALTHY";
  const lastSyncedOverall = rows
    .flatMap((r) => Object.values(r.lastSyncedAt ?? {}).filter((v): v is string => !!v))
    .sort()
    .at(-1);

  return (
    <>
      <Topbar onSearch={setQuery} />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>コマース統合</h1>
            <p className="page-lead">商品・在庫・利益を、ひとつの画面で。</p>
          </div>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button type="button" className="secondary" onClick={exportCsv}>
              <DownloadIcon /> CSV出力
            </button>
            <button type="button" onClick={() => void load()} disabled={loading}>
              <RefreshIcon /> 更新
            </button>
          </div>
        </div>

        <div className="stat-grid">
          <div className="stat-card">
            <span className="stat-card-icon blue">
              <BoxIcon width={18} height={18} />
            </span>
            <div className="stat-value">{rows.length}</div>
            <div className="stat-label">商品数</div>
          </div>
          <Link href="/products" className="stat-card">
            <span className="stat-card-icon orange">
              <ClockIcon width={18} height={18} />
            </span>
            <div className="stat-value">{pendingCount}</div>
            <div className="stat-label">承認待ち</div>
          </Link>
          <div className="stat-card">
            <span className="stat-card-icon green">
              <TagIcon width={18} height={18} />
            </span>
            <div className="stat-value">{activeCount}</div>
            <div className="stat-label">出品中</div>
          </div>
          <div className="stat-card">
            <span className="stat-card-icon purple">
              <CartIcon width={18} height={18} />
            </span>
            <div className="stat-value">{soldOutCount}</div>
            <div className="stat-label">売り切れ</div>
          </div>
          <Link href="/sync-errors" className="stat-card">
            <span className="stat-card-icon red">
              <AlertIcon width={18} height={18} />
            </span>
            <div className="stat-value danger">{errorCount}</div>
            <div className="stat-label">未解決エラー</div>
          </Link>
        </div>

        <div className={`status-bar${bothHealthy ? "" : " warn"}`}>
          <div className="status-bar-left">
            <span className={`status-dot ${bothHealthy ? "ok" : "warn"}`} />
            {bothHealthy ? "同期は正常です" : "同期状態を確認してください"}
            {lastSyncedOverall && (
              <span className="status-bar-meta">最終同期 {new Date(lastSyncedOverall).toLocaleString("ja-JP")}</span>
            )}
          </div>
          <div className="connection-badges">
            <span className="connection-badge">
              <span className={`status-dot ${baseState ? (baseState.state === "HEALTHY" ? "ok" : "warn") : "warn"}`} />
              BASE {baseState ? (baseState.state === "HEALTHY" ? "接続済み" : baseState.state) : "確認中..."}
            </span>
            <span className="connection-badge">
              <span className={`status-dot ${ebayState ? (ebayState.state === "HEALTHY" ? "ok" : "warn") : "warn"}`} />
              eBay {ebayState ? (ebayState.state === "HEALTHY" ? "接続済み" : ebayState.state) : "確認中..."}
              {ebayState && ebayState.state !== "HEALTHY" && (
                <a
                  href={`${getApiBaseUrl()}/oauth/ebay/authorize`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="reconnect-link"
                >
                  再接続
                </a>
              )}
            </span>
          </div>
        </div>

        <div className="commerce-layout">
          <div>
            <div className="filter-tabs" style={{ marginBottom: "0.75rem" }}>
              <button type="button" className="filter-tab" data-active={tab === "all"} onClick={() => setTab("all")}>
                すべて
              </button>
              <button type="button" className="filter-tab" data-active={tab === "pending"} onClick={() => setTab("pending")}>
                承認待ち {pendingCount > 0 && pendingCount}
              </button>
              <button type="button" className="filter-tab" data-active={tab === "active"} onClick={() => setTab("active")}>
                出品中
              </button>
              <button type="button" className="filter-tab" data-active={tab === "lowstock"} onClick={() => setTab("lowstock")}>
                在庫注意 {lowStockRows.length > 0 && lowStockRows.length}
              </button>
            </div>

            {!ready || loading ? (
              <SkeletonRows count={8} />
            ) : filtered.length === 0 ? (
              <div className="table-wrapper">
                <EmptyState>該当する商品がありません。</EmptyState>
              </div>
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>BASE/eBay状態</th>
                      <th>在庫(手持/引当/販売可)</th>
                      <th>売上</th>
                      <th>純利益</th>
                      <th>利益率</th>
                      <th>滞留状態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr
                        key={row.productId}
                        onClick={() => void selectRow(row)}
                        style={{
                          cursor: "pointer",
                          background: row.productId === selectedId ? "var(--accent-soft)" : undefined,
                        }}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{row.title}</div>
                          <div style={{ color: "var(--fg-subtle)", fontSize: "0.8rem" }}>{row.sku}</div>
                        </td>
                        <td>
                          {(["base", "ebay"] as const).map((channel) => (
                            <div key={channel} style={{ marginBottom: 2 }}>
                              {channel.toUpperCase()}:{" "}
                              <span className={CHANNEL_STATUS_BADGE[row.channelStatus[channel] ?? ""] ?? "badge"}>
                                {row.channelStatus[channel] ?? "未登録"}
                              </span>
                            </div>
                          ))}
                        </td>
                        <td>
                          {row.inventory ? (
                            <div>
                              {row.inventory.onHand} / {row.inventory.reserved} /{" "}
                              {Object.entries(row.inventory.sellableByChannel)
                                .map(([c, q]) => `${c}:${q}`)
                                .join(", ")}
                            </div>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>{usd(row.revenueUsdCents)}</td>
                        <td style={{ color: row.netProfitUsdCents < 0 ? "var(--danger)" : undefined }}>
                          {usd(row.netProfitUsdCents)}
                        </td>
                        <td>{pct(row.profitMarginBasisPoints)}</td>
                        <td>
                          <span className={STALE_BADGE[row.staleLevel]}>{STALE_LABEL[row.staleLevel]}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card card-pad detail-panel">
            {!selectedRow ? (
              <div className="detail-empty">商品を選択すると詳細が表示されます。</div>
            ) : (
              <>
                {selectedRow.images?.[0] ? (
                  <img src={selectedRow.images[0]} alt={selectedRow.title} className="detail-thumb" />
                ) : (
                  <div className="detail-thumb" />
                )}
                <h3 style={{ marginTop: "0.9rem" }}>{selectedRow.title}</h3>
                <div style={{ color: "var(--fg-subtle)", fontSize: "0.8rem" }}>{selectedRow.sku}</div>

                <div className="detail-metric-grid">
                  <div className="detail-metric">
                    <div className="detail-metric-value">{selectedRow.inventory?.available ?? "—"}</div>
                    <div className="detail-metric-label">販売可能在庫</div>
                  </div>
                  <div className="detail-metric">
                    <div className="detail-metric-value">
                      {priceLoading ? "…" : dynamicPrice ? `$${dynamicPrice.recommendedPriceUsd.toFixed(2)}` : "—"}
                    </div>
                    <div className="detail-metric-label">AI価格提案</div>
                  </div>
                </div>

                {(selectedRow.channelStatus.base === "error" || selectedRow.channelStatus.ebay === "error") && (
                  <div className="auth-error" style={{ marginBottom: "0.9rem" }}>
                    このチャネルへの同期でエラーが発生しています。同期エラー一覧で詳細をご確認ください。
                  </div>
                )}

                {selectedRow.staleLevel !== "fresh" && (
                  <button
                    type="button"
                    className="secondary"
                    style={{ width: "100%", marginBottom: "0.6rem" }}
                    onClick={() => generateSuggestion(selectedRow.productId)}
                    disabled={busyId === selectedRow.productId}
                  >
                    {busyId === selectedRow.productId ? "生成中..." : "滞留対策のAI提案を生成"}
                  </button>
                )}
                {suggestions[selectedRow.productId] && (
                  <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem", background: "var(--surface-hover)", padding: "0.6rem", borderRadius: 6 }}>
                    {suggestions[selectedRow.productId]}
                  </pre>
                )}

                {selectedRow.snsStatus ? (
                  <div style={{ fontSize: "0.8rem", margin: "0.6rem 0" }}>
                    <div>動画: {selectedRow.snsStatus.videoCreated ? "✓" : "—"}</div>
                    <div>Instagram: {selectedRow.snsStatus.instagramPosted ? "✓" : "—"}</div>
                    <div>TikTok: {selectedRow.snsStatus.tiktokPosted ? "✓" : "—"}</div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="secondary"
                    style={{ width: "100%", marginBottom: "0.6rem" }}
                    onClick={() => generateSnsScript(selectedRow.productId)}
                    disabled={busyId === selectedRow.productId}
                  >
                    {busyId === selectedRow.productId ? "生成中..." : "SNS台本を生成"}
                  </button>
                )}

                <Link href="/products" className="button secondary" style={{ width: "100%" }}>
                  商品を編集
                </Link>
              </>
            )}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginTop: "1.5rem" }}>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.5rem" }}>対応が必要</h2>
            <Link href="/products" className="attention-item">
              承認待ちの商品 <span className="badge warn">{pendingCount}件</span>
            </Link>
            <Link href="/sync-errors" className="attention-item">
              同期エラー <span className="badge error">{errorCount}件</span>
            </Link>
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.5rem" }}>最近の同期</h2>
            {recentAudit.length === 0 ? (
              <EmptyState>まだ記録がありません。</EmptyState>
            ) : (
              recentAudit.map((entry) => (
                <div key={entry.id} className="recent-sync-item">
                  <CheckIcon />
                  <div>
                    <div>{AUDIT_ACTION_LABEL[entry.action] ?? entry.action}</div>
                    <div className="recent-sync-time">{new Date(entry.createdAt).toLocaleString("ja-JP")}</div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </>
  );
}
