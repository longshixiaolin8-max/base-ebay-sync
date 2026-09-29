"use client";

import type { OrderStatus } from "@ai-ec/core";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { ORDER_STATUS_LABEL } from "@/lib/order-copy";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { CartIcon, ClockIcon, CoinIcon, TagIcon, TrendUpIcon } from "@/components/icons";
import { RevenueTrendChart } from "@/components/orders/RevenueTrendChart";
import { ChannelProfitChart } from "@/components/orders/ChannelProfitChart";
import { OrdersTable } from "@/components/orders/OrdersTable";
import { OrderDetailPanel, type ExtraFields } from "@/components/orders/OrderDetailPanel";
import type { OrderRow, OrdersSummary } from "@/components/orders/types";

const EMPTY_EXTRA: ExtraFields = {
  shippingCostJpy: "",
  ebayFeeUsdCents: "",
  paymentFeeUsdCents: "",
  adSpendUsdCents: "",
  fxCostUsdCents: "",
  returnAmountUsdCents: "",
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function jpy(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function deltaBadge(deltaPct: number | null): { text: string; up: boolean } | null {
  if (deltaPct === null) return null;
  return { text: `${deltaPct > 0 ? "+" : ""}${deltaPct}%(前日比)`, up: deltaPct >= 0 };
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

  const [summary, setSummary] = useState<OrdersSummary | null>(null);
  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [avgProfitMarginBasisPoints, setAvgProfitMarginBasisPoints] = useState<number | null>(null);
  const [usdPerJpy, setUsdPerJpy] = useState<number | null>(null);
  const [listLoading, setListLoading] = useState(true);

  const [q, setQ] = useState("");
  const [channel, setChannel] = useState("all");
  const [status, setStatus] = useState("all");
  const [profitStatus, setProfitStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkFinalizing, setBulkFinalizing] = useState(false);

  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"info" | "customer" | "profit" | "timeline">("info");
  const [nextStatus, setNextStatus] = useState<OrderStatus | null>(null);
  const [extra, setExtra] = useState<ExtraFields>(EMPTY_EXTRA);
  const [busy, setBusy] = useState(false);

  const loadSummary = useCallback(async () => {
    try {
      const days = Math.max(1, Math.round((new Date(to).getTime() - new Date(from).getTime()) / (24 * 60 * 60 * 1000)) + 1);
      const res = await apiGet<OrdersSummary>(`/admin/orders/summary?days=${days}`);
      setSummary(res);
    } catch (err) {
      notify(`注文サマリーの取得に失敗しました: ${(err as Error).message}`);
    }
  }, [from, to, notify]);

  const loadOrders = useCallback(async () => {
    setListLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
      if (q.trim()) params.set("q", q.trim());
      if (channel !== "all") params.set("channel", channel);
      if (status !== "all") params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const res = await apiGet<{ orders: OrderRow[]; total: number; avgProfitMarginBasisPoints: number | null; usdPerJpy: number }>(
        `/admin/orders?${params.toString()}`,
      );
      setOrders(res.orders);
      setTotal(res.total);
      setAvgProfitMarginBasisPoints(res.avgProfitMarginBasisPoints);
      setUsdPerJpy(res.usdPerJpy);
    } catch (err) {
      notify(`注文一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setListLoading(false);
    }
  }, [page, pageSize, q, channel, status, from, to, notify]);

  useEffect(() => {
    if (ready) void loadSummary();
  }, [ready, loadSummary]);

  useEffect(() => {
    if (ready) void loadOrders();
  }, [ready, loadOrders]);

  useEffect(() => {
    setNextStatus(null);
    setExtra(EMPTY_EXTRA);
    setActiveTab("info");
  }, [selectedOrderId]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === orders.length ? new Set() : new Set(orders.map((o) => o.id))));
  }

  function clearFilters() {
    setQ("");
    setChannel("all");
    setStatus("all");
    setProfitStatus("all");
    setPage(1);
  }

  async function handleSubmitStatusChange() {
    if (!selectedOrderId || !nextStatus) return;
    const extraPayload: Record<string, number> = {};
    const shippingCostJpy = parseJpy(extra.shippingCostJpy);
    if (shippingCostJpy !== undefined) extraPayload.shippingCostJpy = shippingCostJpy;
    const ebayFee = dollarsToCents(extra.ebayFeeUsdCents);
    if (ebayFee !== undefined) extraPayload.ebayFeeUsdCents = ebayFee;
    const paymentFee = dollarsToCents(extra.paymentFeeUsdCents);
    if (paymentFee !== undefined) extraPayload.paymentFeeUsdCents = paymentFee;
    const adSpend = dollarsToCents(extra.adSpendUsdCents);
    if (adSpend !== undefined) extraPayload.adSpendUsdCents = adSpend;
    const fxCost = dollarsToCents(extra.fxCostUsdCents);
    if (fxCost !== undefined) extraPayload.fxCostUsdCents = fxCost;
    const returnAmount = dollarsToCents(extra.returnAmountUsdCents);
    if (returnAmount !== undefined) extraPayload.returnAmountUsdCents = returnAmount;

    setBusy(true);
    try {
      await apiPost(`/admin/orders/${selectedOrderId}/status`, {
        status: nextStatus,
        extra: Object.keys(extraPayload).length > 0 ? extraPayload : undefined,
      });
      notify(`注文を「${ORDER_STATUS_LABEL[nextStatus]}」に更新しました。`, "success");
      setNextStatus(null);
      setExtra(EMPTY_EXTRA);
      await Promise.all([loadOrders(), loadSummary()]);
    } catch (err) {
      notify(`状態の更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleFinalizeProfit() {
    if (!selectedOrderId) return;
    setBusy(true);
    try {
      await apiPost(`/admin/orders/${selectedOrderId}/finalize-profit`);
      notify("利益を確定しました。", "success");
      await Promise.all([loadOrders(), loadSummary()]);
    } catch (err) {
      notify(`利益の確定に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleBulkFinalize() {
    setBulkFinalizing(true);
    try {
      const ids = [...selectedIds];
      await Promise.all(ids.map((id) => apiPost(`/admin/orders/${id}/finalize-profit`).catch(() => null)));
      notify(`${ids.length}件の利益を確定しました。`, "success");
      setSelectedIds(new Set());
      await Promise.all([loadOrders(), loadSummary()]);
    } catch (err) {
      notify(`一括確定に失敗しました: ${(err as Error).message}`);
    } finally {
      setBulkFinalizing(false);
    }
  }

  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;
  const orderCountDelta = summary ? deltaBadge(summary.kpi.orderCount.deltaPct) : null;
  const revenueDelta = summary ? deltaBadge(summary.kpi.revenueJpy.deltaPct) : null;
  const ebayRevenueDelta = summary ? deltaBadge(summary.kpi.ebayRevenueJpy.deltaPct) : null;
  const profitDelta = summary ? deltaBadge(summary.kpi.netProfitJpy.deltaPct) : null;
  const marginDelta = summary ? deltaBadge(summary.kpi.profitMarginPct.deltaPct) : null;

  return (
    <>
      <Topbar />
      <div className="page">
        <PageHeader
          title="注文管理"
          lead="BASE・eBayの注文履歴、発送状況、利益を一元管理します。"
          actions={
            <div className="draft-date-range">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />〜
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} max={isoDate(new Date())} />
            </div>
          }
        />

        <div className="kpi-grid">
          <KpiCard icon={CartIcon} color="blue" value={summary?.kpi.orderCount.value ?? "..."} label="今日の注文数" sub={orderCountDelta ? <span className={orderCountDelta.up ? "kpi-trend up" : "kpi-trend down"}>{orderCountDelta.up ? "↑" : "↓"} {orderCountDelta.text}</span> : undefined} />
          <KpiCard icon={CoinIcon} color="green" value={summary ? jpy(summary.kpi.revenueJpy.value) : "..."} label="24時間売上" sub={revenueDelta ? <span className={revenueDelta.up ? "kpi-trend up" : "kpi-trend down"}>{revenueDelta.up ? "↑" : "↓"} {revenueDelta.text}</span> : undefined} />
          <KpiCard icon={TagIcon} color="orange" value={summary ? jpy(summary.kpi.ebayRevenueJpy.value) : "..."} label="eBay売上" sub={ebayRevenueDelta ? <span className={ebayRevenueDelta.up ? "kpi-trend up" : "kpi-trend down"}>{ebayRevenueDelta.up ? "↑" : "↓"} {ebayRevenueDelta.text}</span> : undefined} />
          <KpiCard icon={TrendUpIcon} color="green" value={summary ? jpy(summary.kpi.netProfitJpy.value) : "..."} label="粗利" sub={profitDelta ? <span className={profitDelta.up ? "kpi-trend up" : "kpi-trend down"}>{profitDelta.up ? "↑" : "↓"} {profitDelta.text}</span> : undefined} />
          <KpiCard icon={ClockIcon} color="orange" value={summary?.kpi.returnCount.value ?? "..."} label="返品件数" sub={summary ? <span className={summary.kpi.returnCount.deltaAbs <= 0 ? "kpi-trend up" : "kpi-trend down"}>{summary.kpi.returnCount.deltaAbs >= 0 ? "↑" : "↓"} {summary.kpi.returnCount.deltaAbs}(前日比)</span> : undefined} />
          <KpiCard icon={TrendUpIcon} color="green" value={summary?.kpi.profitMarginPct.value != null ? `${summary.kpi.profitMarginPct.value.toFixed(1)}%` : "..."} label="利益率" sub={marginDelta ? <span className={marginDelta.up ? "kpi-trend up" : "kpi-trend down"}>{marginDelta.up ? "↑" : "↓"} {marginDelta.text}</span> : undefined} />
        </div>

        <div className="inventory-charts-row">
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>売上推移</h2>
            {summary && <RevenueTrendChart data={summary.trend} formatJpy={jpy} />}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>チャネル別利益</h2>
            {summary && <ChannelProfitChart base={summary.channelBreakdown.base} ebay={summary.channelBreakdown.ebay} formatJpy={jpy} />}
          </div>
        </div>

        <div className="inventory-main-layout">
          <div className="inventory-main-col">
            <OrdersTable
              orders={orders}
              total={total}
              loading={listLoading}
              usdPerJpy={usdPerJpy}
              q={q}
              onQChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              from={from}
              to={to}
              onFromChange={setFrom}
              onToChange={setTo}
              channel={channel}
              onChannelChange={(v) => {
                setChannel(v);
                setPage(1);
              }}
              status={status}
              onStatusChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              profitStatus={profitStatus}
              onProfitStatusChange={setProfitStatus}
              onClearFilters={clearFilters}
              page={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAll={toggleSelectAll}
              selectedOrderId={selectedOrderId}
              onSelectRow={(id) => setSelectedOrderId((cur) => (cur === id ? null : id))}
              onBulkFinalize={handleBulkFinalize}
              bulkFinalizing={bulkFinalizing}
            />
          </div>

          {selectedOrder && (
            <div className="inventory-side-col">
              <OrderDetailPanel
                order={selectedOrder}
                usdPerJpy={usdPerJpy}
                avgProfitMarginBasisPoints={avgProfitMarginBasisPoints}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                nextStatus={nextStatus}
                onNextStatusChange={setNextStatus}
                extra={extra}
                onExtraChange={setExtra}
                onSubmitStatusChange={handleSubmitStatusChange}
                onFinalizeProfit={handleFinalizeProfit}
                busy={busy}
                onClose={() => setSelectedOrderId(null)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
