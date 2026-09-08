"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { getApiBaseUrl } from "@/lib/amplify-config";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AUDIT_ACTION_LABEL } from "@/lib/audit-action-copy";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { CheckIcon, ClockIcon, CoinIcon, DownloadIcon, RefreshIcon } from "@/components/icons";

interface ChannelSyncState {
  channel: string;
  state: "HEALTHY" | "DEGRADED" | "ISOLATED" | "RECOVERING" | "RECONCILING";
}

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
  costUsdCents: number | null;
  currentEbayPriceUsdCents: number | null;
  revenueUsdCents: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints: number | null;
  daysListed: number;
  staleLevel: "fresh" | "stale_30" | "stale_60" | "stale_90";
  snsStatus: SnsStatus | null;
}

interface DynamicPrice {
  recommendedPriceUsd: number;
  netMarginRatio: number;
  costMarkupRatio: number;
  fxSource: string;
}

const STALE_BADGE: Record<CommerceRow["staleLevel"], string> = {
  fresh: "badge ok",
  stale_30: "badge warn",
  stale_60: "badge warn",
  stale_90: "badge error",
};

const LOW_MARGIN_THRESHOLD_BP = 1500; // 15% -- this screen's own definition, not a platform-wide setting.

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
  const [tab, setTab] = useState<"all" | "stale" | "lowmargin" | "lowstock">("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [priceByProduct, setPriceByProduct] = useState<Record<string, DynamicPrice | "loading" | "unavailable">>({});
  const [reasonShownFor, setReasonShownFor] = useState<string | null>(null);
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

  async function toggleExpand(row: CommerceRow) {
    const next = expandedId === row.productId ? null : row.productId;
    setExpandedId(next);
    if (next && !priceByProduct[row.productId]) {
      setPriceByProduct((prev) => ({ ...prev, [row.productId]: "loading" }));
      try {
        const price = await apiGet<DynamicPrice>(`/admin/products/${row.productId}/dynamic-price`);
        setPriceByProduct((prev) => ({ ...prev, [row.productId]: price }));
      } catch {
        setPriceByProduct((prev) => ({ ...prev, [row.productId]: "unavailable" }));
      }
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
    const header = ["SKU", "商品名", "BASE状態", "eBay状態", "手持在庫", "販売可能", "売上", "純利益", "滞留日数"];
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
        r.daysListed,
      ]
        .map(csvEscape)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `commerce-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const staleRows = rows.filter((r) => r.staleLevel !== "fresh");
  const lowMarginRows = rows.filter((r) => r.profitMarginBasisPoints !== null && r.profitMarginBasisPoints < LOW_MARGIN_THRESHOLD_BP);
  const lowStockRows = rows.filter((r) => r.inventory && r.inventory.available <= r.inventory.safetyBuffer);

  // 在庫原価: only summed across rows that actually have cost data entered -- a product
  // with no cost_jpy is excluded rather than silently treated as costing 0, and the count
  // of excluded rows is disclosed next to the total so it never reads as a complete figure
  // when it isn't.
  // typeof-checked rather than !== null: until this round's backend deploy lands, the
  // live API simply omits costUsdCents (undefined), which must be treated the same as an
  // explicit null (no cost entered) -- never coerced into NaN/0 by an unguarded arithmetic op.
  const rowsWithCost = rows.filter((r) => typeof r.costUsdCents === "number" && r.inventory);
  const totalCostUsdCents = rowsWithCost.reduce((sum, r) => sum + r.costUsdCents! * r.inventory!.onHand, 0);
  const missingCostCount = rows.filter((r) => typeof r.costUsdCents !== "number").length;

  const totalRevenue = rows.reduce((sum, r) => sum + r.revenueUsdCents, 0);
  const totalProfit = rows.reduce((sum, r) => sum + r.netProfitUsdCents, 0);
  const overallMarginBp = totalRevenue > 0 ? Math.round((totalProfit / totalRevenue) * 10000) : null;

  const filtered = useMemo(() => {
    let list = rows;
    if (tab === "stale") list = list.filter((r) => r.staleLevel !== "fresh");
    else if (tab === "lowmargin") list = list.filter((r) => r.profitMarginBasisPoints !== null && r.profitMarginBasisPoints < LOW_MARGIN_THRESHOLD_BP);
    else if (tab === "lowstock") list = list.filter((r) => r.inventory && r.inventory.available <= r.inventory.safetyBuffer);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((r) => r.title.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q));
    }
    return list;
  }, [rows, tab, query]);

  return (
    <>
      <Topbar onSearch={setQuery} />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>コマース統合</h1>
            <p className="page-lead">在庫・利益・滞留状況を、ひとつの画面で。</p>
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

        {!ready || loading ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className={`status-bar${baseState?.state === "HEALTHY" && ebayState?.state === "HEALTHY" ? "" : " warn"}`}>
              <div className="status-bar-left">
                <span className={`status-dot ${baseState?.state === "HEALTHY" && ebayState?.state === "HEALTHY" ? "ok" : "warn"}`} />
                {baseState?.state === "HEALTHY" && ebayState?.state === "HEALTHY" ? "同期は正常です" : "同期状態を確認してください"}
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
                    <a href={`${getApiBaseUrl()}/oauth/ebay/authorize`} target="_blank" rel="noopener noreferrer" className="reconnect-link">
                      再接続
                    </a>
                  )}
                </span>
              </div>
            </div>

            <div className="kpi-grid" style={{ marginTop: "1rem" }}>
              <div className="kpi-card">
                <span className="stat-card-icon blue">
                  <CoinIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{usd(totalCostUsdCents)}</div>
                <div className="kpi-label">在庫原価</div>
                <div className="kpi-sub">
                  {missingCostCount > 0 ? (
                    <span>{missingCostCount}商品は仕入価格未入力のため未集計</span>
                  ) : (
                    <span>全商品を集計済み</span>
                  )}
                </div>
              </div>
              <div className="kpi-card">
                <span className="stat-card-icon green">
                  <CoinIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{pct(overallMarginBp)}</div>
                <div className="kpi-label">見込み利益率</div>
                <div className="kpi-sub">確定前の実績ベース(FX変動により実際の着金額とは異なる場合があります)</div>
              </div>
              <div className="kpi-card">
                <span className="stat-card-icon orange">
                  <ClockIcon width={18} height={18} />
                </span>
                <div className="kpi-value">{staleRows.length}点</div>
                <div className="kpi-label">滞留商品</div>
                <div className="kpi-sub">出品から30日以上動きのない商品</div>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="table-wrapper" style={{ marginTop: "1.25rem" }}>
                <EmptyState>商品がまだありません。</EmptyState>
              </div>
            ) : (
              <>
                <div className="filter-tabs" style={{ marginTop: "1.25rem", marginBottom: "0.75rem" }}>
                  <button type="button" className="filter-tab" data-active={tab === "all"} onClick={() => setTab("all")}>
                    全商品 ({rows.length})
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "stale"} onClick={() => setTab("stale")}>
                    滞留 {staleRows.length > 0 && staleRows.length}
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "lowmargin"} onClick={() => setTab("lowmargin")}>
                    低利益率 {lowMarginRows.length > 0 && lowMarginRows.length}
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "lowstock"} onClick={() => setTab("lowstock")}>
                    在庫注意 {lowStockRows.length > 0 && lowStockRows.length}
                  </button>
                </div>

                {filtered.length === 0 ? (
                  <div className="table-wrapper">
                    <EmptyState>該当する商品がありません。</EmptyState>
                  </div>
                ) : (
                  <div className="product-card-list">
                    {filtered.map((row) => {
                      const expanded = expandedId === row.productId;
                      const price = priceByProduct[row.productId];
                      return (
                        <div key={row.productId} className="product-card" style={{ flexDirection: "column", alignItems: "stretch" }}>
                          <button
                            type="button"
                            onClick={() => void toggleExpand(row)}
                            style={{
                              display: "flex",
                              gap: "0.75rem",
                              alignItems: "flex-start",
                              background: "none",
                              border: "none",
                              padding: 0,
                              textAlign: "left",
                              cursor: "pointer",
                              width: "100%",
                            }}
                          >
                            {row.images?.[0] ? <img src={row.images[0]} alt="" className="product-card-thumb" /> : <div className="product-card-thumb" />}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap", alignItems: "center" }}>
                                {row.staleLevel !== "fresh" && <span className={STALE_BADGE[row.staleLevel]}>滞留{row.daysListed}日</span>}
                              </div>
                              <div style={{ fontWeight: 700, marginTop: "0.2rem" }}>{row.title}</div>
                              <div style={{ color: "var(--fg-subtle)", fontSize: "0.8rem" }}>{row.sku}</div>
                              <div style={{ display: "flex", gap: "1rem", fontSize: "0.8rem", marginTop: "0.35rem", flexWrap: "wrap" }}>
                                <span>BASE在庫 {row.inventory?.sellableByChannel.base ?? "—"}</span>
                                <span>eBay在庫 {row.inventory?.sellableByChannel.ebay ?? "—"}</span>
                                <span style={{ color: row.netProfitUsdCents < 0 ? "var(--danger)" : undefined }}>
                                  見込み利益 {usd(row.netProfitUsdCents)}
                                </span>
                              </div>
                            </div>
                            <span style={{ color: "var(--fg-subtle)", flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
                          </button>

                          {expanded && (
                            <div style={{ marginTop: "0.9rem", borderTop: "1px solid var(--border)", paddingTop: "0.9rem" }}>
                              <div className="section-eyebrow" style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                ✨ AI 価格見直しの提案
                              </div>
                              {price === "loading" || !price ? (
                                <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)" }}>計算中...</p>
                              ) : price === "unavailable" ? (
                                <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)" }}>価格提案を計算できませんでした。</p>
                              ) : (
                                <>
                                  <div className="detail-metric-grid">
                                    <div className="detail-metric">
                                      <div className="detail-metric-label">現在のeBay価格</div>
                                      <div className="detail-metric-value">
                                        {typeof row.currentEbayPriceUsdCents === "number" ? usd(row.currentEbayPriceUsdCents) : "未出品"}
                                      </div>
                                    </div>
                                    <div className="detail-metric">
                                      <div className="detail-metric-label">提案価格</div>
                                      <div className="detail-metric-value" style={{ color: "var(--accent)" }}>
                                        ${price.recommendedPriceUsd.toFixed(2)}
                                      </div>
                                    </div>
                                  </div>
                                  <p style={{ fontSize: "0.82rem", margin: "0.6rem 0" }}>
                                    提案価格での見込み利益(1点あたり): {usd(Math.round(price.recommendedPriceUsd * price.netMarginRatio * 100))} (利益率{" "}
                                    {(price.netMarginRatio * 100).toFixed(1)}%)
                                  </p>
                                  <div className="auth-callout" style={{ marginTop: 0 }}>
                                    <span>
                                      この提案は未適用です。価格の実反映はまだこの画面から行えません — 商品詳細から手動で更新してください。
                                    </span>
                                  </div>
                                  <button
                                    type="button"
                                    className="secondary"
                                    style={{ marginTop: "0.6rem" }}
                                    onClick={() => setReasonShownFor(reasonShownFor === row.productId ? null : row.productId)}
                                  >
                                    提案の根拠をみる
                                  </button>
                                  {reasonShownFor === row.productId && (
                                    <p style={{ fontSize: "0.76rem", color: "var(--fg-subtle)", marginTop: "0.5rem" }}>
                                      仕入価格・送料・目標利益率と、為替レート(取得元: {price.fxSource})から算出しています。相場データは使用していません。
                                    </p>
                                  )}
                                </>
                              )}

                              {row.staleLevel !== "fresh" && (
                                <button
                                  type="button"
                                  className="secondary"
                                  style={{ width: "100%", marginTop: "0.9rem" }}
                                  onClick={() => generateSuggestion(row.productId)}
                                  disabled={busyId === row.productId}
                                >
                                  {busyId === row.productId ? "生成中..." : "滞留対策のAI提案を生成"}
                                </button>
                              )}
                              {suggestions[row.productId] && (
                                <pre
                                  style={{
                                    whiteSpace: "pre-wrap",
                                    fontSize: "0.75rem",
                                    background: "var(--surface-hover)",
                                    padding: "0.6rem",
                                    borderRadius: 6,
                                    marginTop: "0.5rem",
                                  }}
                                >
                                  {suggestions[row.productId]}
                                </pre>
                              )}

                              {row.snsStatus ? (
                                <div style={{ fontSize: "0.8rem", margin: "0.6rem 0" }}>
                                  <div>動画: {row.snsStatus.videoCreated ? "✓" : "—"}</div>
                                  <div>Instagram: {row.snsStatus.instagramPosted ? "✓" : "—"}</div>
                                  <div>TikTok: {row.snsStatus.tiktokPosted ? "✓" : "—"}</div>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  className="secondary"
                                  style={{ width: "100%", marginTop: "0.5rem" }}
                                  onClick={() => generateSnsScript(row.productId)}
                                  disabled={busyId === row.productId}
                                >
                                  {busyId === row.productId ? "生成中..." : "SNS台本を生成"}
                                </button>
                              )}

                              <Link href={`/products/detail?id=${row.productId}`} className="button secondary" style={{ width: "100%", marginTop: "0.6rem", display: "block", textAlign: "center" }}>
                                商品詳細を開く
                              </Link>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginTop: "1.5rem" }}>
              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.5rem" }}>対応が必要</h2>
                <Link href="/products" className="attention-item">
                  承認待ちの商品 <span className="badge warn">{rows.filter((r) => r.status === "ai_generated").length}件</span>
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
          </>
        )}
      </div>
    </>
  );
}
