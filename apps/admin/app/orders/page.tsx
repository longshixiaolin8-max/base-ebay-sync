"use client";

import type { OrderStatus } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { isOrderStatusTerminal, ORDER_STATUS_BADGE, ORDER_STATUS_LABEL, validNextOrderStatuses } from "@/lib/order-copy";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { ChevronIcon, RefreshIcon } from "@/components/icons";

interface OrderProduct {
  id: string;
  sku: string;
  title: string;
  images: string[];
}

interface OrderRow {
  id: string;
  productId: string;
  channel: string;
  externalOrderId: string;
  quantity: number;
  status: OrderStatus;
  finalizedNetProfitUsdCents: number | null;
  profitFinalizedAt: string | null;
  placedAt: string;
  product: OrderProduct | null;
}

interface LiveProfit {
  finalized: boolean;
  revenueUsdCents?: number;
  costUsdCents?: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints?: number | null;
  profitFinalizedAt?: string;
}

interface ExtraFields {
  shippingCostJpy: string;
  ebayFeeUsdCents: string;
  paymentFeeUsdCents: string;
  adSpendUsdCents: string;
  fxCostUsdCents: string;
  returnAmountUsdCents: string;
}

const EMPTY_EXTRA: ExtraFields = {
  shippingCostJpy: "",
  ebayFeeUsdCents: "",
  paymentFeeUsdCents: "",
  adSpendUsdCents: "",
  fxCostUsdCents: "",
  returnAmountUsdCents: "",
};

type Tab = "all" | "unshipped" | "shipped" | "returns";

const TAB_STATUSES: Record<Exclude<Tab, "all">, OrderStatus[]> = {
  unshipped: ["ORDER_RECEIVED", "PAID", "ALLOCATED"],
  shipped: ["SHIPPED", "DELIVERED"],
  returns: ["RETURN_REQUESTED", "RETURNED", "REFUNDED", "CANCELLED"],
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function withoutKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

function parseJpy(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function dollarsToCents(value: string): number | undefined {
  if (value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : undefined;
}

export default function OrdersPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [profitById, setProfitById] = useState<Record<string, LiveProfit | "loading">>({});
  const [nextStatus, setNextStatus] = useState<Record<string, OrderStatus>>({});
  const [extra, setExtra] = useState<Record<string, ExtraFields>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ orders: OrderRow[] }>("/admin/orders?limit=200");
      setRows(res.orders);
    } catch (err) {
      notify(`注文一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function toggleExpand(row: OrderRow) {
    const next = expandedId === row.id ? null : row.id;
    setExpandedId(next);
    if (next && !profitById[row.id]) {
      setProfitById((prev) => ({ ...prev, [row.id]: "loading" }));
      try {
        const profit = await apiGet<LiveProfit>(`/admin/orders/${row.id}/profit`);
        setProfitById((prev) => ({ ...prev, [row.id]: profit }));
      } catch (err) {
        notify(`利益情報の取得に失敗しました: ${(err as Error).message}`);
        setProfitById((prev) => withoutKey(prev, row.id));
      }
    }
  }

  async function submitStatusChange(row: OrderRow) {
    const target = nextStatus[row.id];
    if (!target) return;
    const fields = extra[row.id] ?? EMPTY_EXTRA;
    const extraPayload: Record<string, number> = {};
    const shippingCostJpy = parseJpy(fields.shippingCostJpy);
    if (shippingCostJpy !== undefined) extraPayload.shippingCostJpy = shippingCostJpy;
    const ebayFee = dollarsToCents(fields.ebayFeeUsdCents);
    if (ebayFee !== undefined) extraPayload.ebayFeeUsdCents = ebayFee;
    const paymentFee = dollarsToCents(fields.paymentFeeUsdCents);
    if (paymentFee !== undefined) extraPayload.paymentFeeUsdCents = paymentFee;
    const adSpend = dollarsToCents(fields.adSpendUsdCents);
    if (adSpend !== undefined) extraPayload.adSpendUsdCents = adSpend;
    const fxCost = dollarsToCents(fields.fxCostUsdCents);
    if (fxCost !== undefined) extraPayload.fxCostUsdCents = fxCost;
    const returnAmount = dollarsToCents(fields.returnAmountUsdCents);
    if (returnAmount !== undefined) extraPayload.returnAmountUsdCents = returnAmount;

    setBusyId(row.id);
    try {
      await apiPost(`/admin/orders/${row.id}/status`, {
        status: target,
        extra: Object.keys(extraPayload).length > 0 ? extraPayload : undefined,
      });
      notify(`注文を「${ORDER_STATUS_LABEL[target]}」に更新しました。`, "success");
      setProfitById((prev) => withoutKey(prev, row.id));
      setExtra((prev) => ({ ...prev, [row.id]: EMPTY_EXTRA }));
      await load();
    } catch (err) {
      notify(`状態の更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function finalize(row: OrderRow) {
    setBusyId(row.id);
    try {
      const res = await apiPost<{ order: OrderRow }>(`/admin/orders/${row.id}/finalize-profit`);
      notify("利益を確定しました。", "success");
      setProfitById((prev) => ({
        ...prev,
        [row.id]: { finalized: true, netProfitUsdCents: res.order.finalizedNetProfitUsdCents ?? 0 },
      }));
      await load();
    } catch (err) {
      notify(`利益の確定に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  const counts = useMemo(() => {
    const unshipped = rows.filter((r) => TAB_STATUSES.unshipped.includes(r.status)).length;
    const shipped = rows.filter((r) => TAB_STATUSES.shipped.includes(r.status)).length;
    const returns = rows.filter((r) => TAB_STATUSES.returns.includes(r.status)).length;
    // Live (non-finalized) profit isn't loaded for every row up front -- only fetched
    // per-row on expand -- so this is a count, not a summed dollar figure.
    const unfinalizedCount = rows.filter((r) => !r.profitFinalizedAt).length;
    return { unshipped, shipped, returns, unfinalizedCount };
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (tab !== "all") list = list.filter((r) => TAB_STATUSES[tab].includes(r.status));
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (r) =>
          (r.product?.title.toLowerCase().includes(q) ?? false) ||
          (r.product?.sku.toLowerCase().includes(q) ?? false) ||
          r.externalOrderId.toLowerCase().includes(q),
      );
    }
    return list;
  }, [rows, tab, query]);

  return (
    <>
      <Topbar onSearch={setQuery} searchPlaceholder="商品名・SKU・注文IDで検索..." />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>注文管理</h1>
            <p className="page-lead">BASE・eBayの注文状態を追跡し、利益を確定します。</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}>
            <RefreshIcon /> 更新
          </button>
        </div>

        {!ready || loading ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-value">{counts.unshipped}</div>
                <div className="kpi-label">未出荷</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value">{counts.shipped}</div>
                <div className="kpi-label">出荷済み</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value">{counts.returns}</div>
                <div className="kpi-label">返品・キャンセル</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value">{counts.unfinalizedCount}</div>
                <div className="kpi-label">利益未確定</div>
              </div>
            </div>

            {rows.length === 0 ? (
              <div className="table-wrapper" style={{ marginTop: "1.25rem" }}>
                <EmptyState>まだ注文がありません。BASE・eBayでの売却が検知されると自動的にここに記録されます。</EmptyState>
              </div>
            ) : (
              <>
                <div className="filter-tabs" style={{ marginTop: "1.25rem", marginBottom: "0.75rem" }}>
                  <button type="button" className="filter-tab" data-active={tab === "all"} onClick={() => setTab("all")}>
                    全て ({rows.length})
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "unshipped"} onClick={() => setTab("unshipped")}>
                    未出荷 {counts.unshipped > 0 && counts.unshipped}
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "shipped"} onClick={() => setTab("shipped")}>
                    出荷済み {counts.shipped > 0 && counts.shipped}
                  </button>
                  <button type="button" className="filter-tab" data-active={tab === "returns"} onClick={() => setTab("returns")}>
                    返品・キャンセル {counts.returns > 0 && counts.returns}
                  </button>
                </div>

                {filtered.length === 0 ? (
                  <div className="table-wrapper">
                    <EmptyState>該当する注文がありません。</EmptyState>
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
                    {filtered.map((row) => {
                      const expanded = expandedId === row.id;
                      const profit = profitById[row.id];
                      const nextOptions = validNextOrderStatuses(row.status);
                      const fields = extra[row.id] ?? EMPTY_EXTRA;
                      return (
                        <div key={row.id} className="card">
                          <button
                            type="button"
                            onClick={() => void toggleExpand(row)}
                            style={{
                              display: "flex",
                              gap: "0.75rem",
                              alignItems: "center",
                              background: "none",
                              border: "none",
                              padding: "0.9rem 1rem",
                              textAlign: "left",
                              cursor: "pointer",
                              width: "100%",
                            }}
                          >
                            {row.product?.images?.[0] ? (
                              <img src={row.product.images[0]} alt="" className="product-card-thumb" style={{ width: 48, height: 48 }} />
                            ) : (
                              <div className="product-card-thumb" style={{ width: 48, height: 48 }} />
                            )}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                                <span className={ORDER_STATUS_BADGE[row.status]}>{ORDER_STATUS_LABEL[row.status]}</span>
                                <span className="badge">{row.channel.toUpperCase()}</span>
                                {row.profitFinalizedAt && <span className="badge ok">利益確定済み</span>}
                              </div>
                              <div style={{ fontWeight: 700, marginTop: "0.25rem" }}>{row.product?.title ?? row.productId}</div>
                              <div style={{ color: "var(--fg-subtle)", fontSize: "0.8rem" }}>
                                {row.product?.sku ?? "—"} ・ 注文ID {row.externalOrderId} ・ 数量 {row.quantity} ・{" "}
                                {new Date(row.placedAt).toLocaleDateString("ja-JP")}
                              </div>
                            </div>
                            <span style={{ fontWeight: 700 }}>
                              {row.profitFinalizedAt ? usd(row.finalizedNetProfitUsdCents ?? 0) : "—"}
                            </span>
                            <ChevronIcon style={{ transform: expanded ? "rotate(180deg)" : undefined, flexShrink: 0 }} />
                          </button>

                          {expanded && (
                            <div style={{ padding: "0 1rem 1rem", borderTop: "1px solid var(--border)" }}>
                              <div className="section-eyebrow" style={{ marginTop: "0.9rem" }}>利益</div>
                              {profit === "loading" || !profit ? (
                                <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)" }}>計算中...</p>
                              ) : (
                                <div className="detail-metric-grid">
                                  <div className="detail-metric">
                                    <div className="detail-metric-value">
                                      {usd(profit.finalized ? (row.finalizedNetProfitUsdCents ?? 0) : profit.netProfitUsdCents)}
                                    </div>
                                    <div className="detail-metric-label">{profit.finalized ? "確定利益" : "見込み利益(未確定)"}</div>
                                  </div>
                                  {!profit.finalized && typeof profit.revenueUsdCents === "number" && (
                                    <div className="detail-metric">
                                      <div className="detail-metric-value">{usd(profit.revenueUsdCents)}</div>
                                      <div className="detail-metric-label">売上</div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {!row.profitFinalizedAt && (
                                <>
                                  <div className="section-eyebrow" style={{ marginTop: "1rem" }}>状態を更新</div>
                                  {isOrderStatusTerminal(row.status) ? (
                                    <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)" }}>この注文はこれ以上状態を進められません。</p>
                                  ) : (
                                    <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                                      {nextOptions.map((s) => (
                                        <button
                                          key={s}
                                          type="button"
                                          className={nextStatus[row.id] === s ? "" : "secondary"}
                                          onClick={() => setNextStatus((prev) => ({ ...prev, [row.id]: s }))}
                                        >
                                          {ORDER_STATUS_LABEL[s]}
                                        </button>
                                      ))}
                                    </div>
                                  )}

                                  {nextStatus[row.id] && (
                                    <div style={{ marginTop: "0.75rem" }}>
                                      <div className="specifics-grid">
                                        <label className="specifics-field">
                                          <span>送料(JPY)</span>
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            value={fields.shippingCostJpy}
                                            onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, shippingCostJpy: e.target.value } }))}
                                          />
                                        </label>
                                        <label className="specifics-field">
                                          <span>eBay手数料(USD)</span>
                                          <input
                                            type="text"
                                            inputMode="decimal"
                                            value={fields.ebayFeeUsdCents}
                                            onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, ebayFeeUsdCents: e.target.value } }))}
                                          />
                                        </label>
                                        <label className="specifics-field">
                                          <span>決済手数料(USD)</span>
                                          <input
                                            type="text"
                                            inputMode="decimal"
                                            value={fields.paymentFeeUsdCents}
                                            onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, paymentFeeUsdCents: e.target.value } }))}
                                          />
                                        </label>
                                        <label className="specifics-field">
                                          <span>広告費(USD)</span>
                                          <input
                                            type="text"
                                            inputMode="decimal"
                                            value={fields.adSpendUsdCents}
                                            onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, adSpendUsdCents: e.target.value } }))}
                                          />
                                        </label>
                                        <label className="specifics-field">
                                          <span>為替コスト(USD)</span>
                                          <input
                                            type="text"
                                            inputMode="decimal"
                                            value={fields.fxCostUsdCents}
                                            onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, fxCostUsdCents: e.target.value } }))}
                                          />
                                        </label>
                                        {(nextStatus[row.id] === "RETURNED" || row.status === "RETURN_REQUESTED") && (
                                          <label className="specifics-field">
                                            <span>返金額(USD)</span>
                                            <input
                                              type="text"
                                              inputMode="decimal"
                                              value={fields.returnAmountUsdCents}
                                              onChange={(e) => setExtra((prev) => ({ ...prev, [row.id]: { ...fields, returnAmountUsdCents: e.target.value } }))}
                                            />
                                          </label>
                                        )}
                                      </div>
                                      <button
                                        type="button"
                                        style={{ marginTop: "0.75rem" }}
                                        onClick={() => void submitStatusChange(row)}
                                        disabled={busyId === row.id}
                                      >
                                        {busyId === row.id ? "更新中..." : `「${ORDER_STATUS_LABEL[nextStatus[row.id]!]}」に更新`}
                                      </button>
                                    </div>
                                  )}
                                </>
                              )}

                              {profit && profit !== "loading" && !profit.finalized && (
                                <button
                                  type="button"
                                  className="secondary"
                                  style={{ marginTop: "0.9rem" }}
                                  onClick={() => void finalize(row)}
                                  disabled={busyId === row.id}
                                >
                                  {busyId === row.id ? "処理中..." : "利益を確定する"}
                                </button>
                              )}

                              <Link
                                href={`/products/detail?id=${row.productId}`}
                                className="button secondary"
                                style={{ width: "100%", marginTop: "0.6rem", display: "block", textAlign: "center" }}
                              >
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
          </>
        )}
      </div>
    </>
  );
}
