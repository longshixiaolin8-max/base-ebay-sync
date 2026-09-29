"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { AlertIcon, BoxIcon, RefreshIcon, ShieldIcon, TrendUpIcon } from "@/components/icons";
import { InventoryHealthBar } from "@/components/inventory/InventoryHealthBar";
import { InventoryTrendChart } from "@/components/inventory/InventoryTrendChart";
import { HowItWorksCard } from "@/components/inventory/HowItWorksCard";
import { InventoryTable } from "@/components/inventory/InventoryTable";
import { ProductDetailPanel } from "@/components/inventory/ProductDetailPanel";
import type { InventoryHealthByChannel, InventoryKpi, InventoryProductRow, InventoryTrendPoint, ProductDetail, SyncErrorRow, SyncTraceEntry } from "@/components/inventory/types";

export default function InventoryPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();

  const [products, setProducts] = useState<InventoryProductRow[]>([]);
  const [total, setTotal] = useState(0);
  const [inventoryKpi, setInventoryKpi] = useState<InventoryKpi | null>(null);
  const [healthByChannel, setHealthByChannel] = useState<InventoryHealthByChannel | null>(null);
  const [trend, setTrend] = useState<InventoryTrendPoint[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const [q, setQ] = useState("");
  const [diffStatus, setDiffStatus] = useState("all");
  const [channel, setChannel] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReconstructing, setBulkReconstructing] = useState(false);

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"overview" | "history">("overview");
  const [syncTrace, setSyncTrace] = useState<SyncTraceEntry[]>([]);
  const [syncTraceLoading, setSyncTraceLoading] = useState(false);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [possibleDoubleSaleErrorId, setPossibleDoubleSaleErrorId] = useState<string | null>(null);

  const [reconstructPreview, setReconstructPreview] = useState<{ currentQuantity: number; reconstructedQuantity: number; drifted: boolean } | null>(null);
  const [checkingReconstruct, setCheckingReconstruct] = useState(false);
  const [applyingReconstruct, setApplyingReconstruct] = useState(false);

  const loadProducts = useCallback(async () => {
    setListLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
      if (q.trim()) params.set("q", q.trim());
      if (diffStatus !== "all") params.set("diffStatus", diffStatus);
      if (channel !== "all") params.set("channel", channel);
      const res = await apiGet<{
        products: InventoryProductRow[];
        total: number;
        inventoryKpi: InventoryKpi;
        inventoryHealthByChannel: InventoryHealthByChannel;
        inventoryTrend: InventoryTrendPoint[];
      }>(`/admin/products/list?${params.toString()}`);
      setProducts(res.products);
      setTotal(res.total);
      setInventoryKpi(res.inventoryKpi);
      setHealthByChannel(res.inventoryHealthByChannel);
      setTrend(res.inventoryTrend);
    } catch (err) {
      notify(`在庫一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setListLoading(false);
    }
  }, [page, pageSize, q, diffStatus, channel, notify]);

  const loadDetail = useCallback(async (productId: string) => {
    setDetailLoading(true);
    setReconstructPreview(null);
    try {
      const [d, errors] = await Promise.all([
        apiGet<ProductDetail>(`/admin/products/${productId}`),
        apiGet<{ syncErrors: SyncErrorRow[] }>(`/admin/sync-errors?resolved=false&productId=${productId}`),
      ]);
      setDetail(d);
      const doubleSale = errors.syncErrors.find((e) => e.errorCode === "possible_double_sale");
      setPossibleDoubleSaleErrorId(doubleSale?.id ?? null);
    } catch (err) {
      notify(`商品詳細の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setDetailLoading(false);
    }
  }, [notify]);

  const loadSyncTrace = useCallback(async (productId: string, limit: number) => {
    setSyncTraceLoading(true);
    try {
      const res = await apiGet<SyncTraceEntry[] | { entries: SyncTraceEntry[] }>(`/admin/products/${productId}/sync-trace?limit=${limit}`);
      setSyncTrace(Array.isArray(res) ? res : res.entries);
    } catch (err) {
      notify(`イベント履歴の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setSyncTraceLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (ready) void loadProducts();
  }, [ready, loadProducts]);

  useEffect(() => {
    if (!selectedProductId) {
      setDetail(null);
      setSyncTrace([]);
      setActiveTab("overview");
      setHistoryExpanded(false);
      return;
    }
    void loadDetail(selectedProductId);
    void loadSyncTrace(selectedProductId, 20);
    setActiveTab("overview");
    setHistoryExpanded(false);
  }, [selectedProductId, loadDetail, loadSyncTrace]);

  function selectRow(id: string) {
    setSelectedProductId((current) => (current === id ? null : id));
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === products.length ? new Set() : new Set(products.map((p) => p.id))));
  }

  async function handleBulkReconstruct() {
    setBulkReconstructing(true);
    try {
      const ids = [...selectedIds];
      const results = await Promise.all(
        ids.map((id) => apiPost<{ applied: boolean }>(`/admin/products/${id}/reconstruct-inventory`).catch(() => null)),
      );
      const appliedCount = results.filter((r) => r?.applied).length;
      notify(`${ids.length}件を確認し、${appliedCount}件の在庫を再構築しました。`, "success");
      setSelectedIds(new Set());
      await loadProducts();
    } catch (err) {
      notify(`一括再構築に失敗しました: ${(err as Error).message}`);
    } finally {
      setBulkReconstructing(false);
    }
  }

  async function handleCheckReconstruct() {
    if (!selectedProductId) return;
    setCheckingReconstruct(true);
    try {
      const preview = await apiGet<{ currentQuantity: number; reconstructedQuantity: number; drifted: boolean }>(
        `/admin/products/${selectedProductId}/reconstruct-inventory`,
      );
      setReconstructPreview(preview);
    } catch (err) {
      notify(`在庫の再構築チェックに失敗しました: ${(err as Error).message}`);
    } finally {
      setCheckingReconstruct(false);
    }
  }

  async function handleApplyReconstruct() {
    if (!selectedProductId) return;
    setApplyingReconstruct(true);
    try {
      const result = await apiPost<{ currentQuantity: number; reconstructedQuantity: number; drifted: boolean; applied: boolean }>(
        `/admin/products/${selectedProductId}/reconstruct-inventory`,
      );
      setReconstructPreview(result);
      notify(result.applied ? "在庫を再構築しました。" : "差分がなかったため、変更はありませんでした。", "success");
      await Promise.all([loadProducts(), loadDetail(selectedProductId)]);
    } catch (err) {
      notify(`在庫の再構築に失敗しました: ${(err as Error).message}`);
    } finally {
      setApplyingReconstruct(false);
    }
  }

  function handleExpandHistory() {
    if (!selectedProductId) return;
    setHistoryExpanded(true);
    void loadSyncTrace(selectedProductId, 100);
  }

  const selectedRow = products.find((p) => p.id === selectedProductId) ?? null;

  return (
    <>
      <Topbar />
      <div className="page">
        <PageHeader title="在庫監視" lead="中央在庫で一元管理し、安全在庫を考慮して即時同期。在庫の差分検知とダブル売りを未然に防ぎます。" />

        <div className="kpi-grid">
          <KpiCard icon={BoxIcon} color="blue" value={inventoryKpi?.monitored ?? "..."} label="監視対象商品数" />
          <KpiCard icon={AlertIcon} color="orange" value={inventoryKpi?.diffCount ?? "..."} label="在庫差分" />
          <KpiCard icon={ShieldIcon} color="green" value={inventoryKpi?.safetyStockAppliedCount ?? "..."} label="safety stock適用数" />
          <KpiCard icon={AlertIcon} color="red" value={inventoryKpi?.possibleDoubleSaleCount ?? "..."} label="possible_double_sale" />
          <KpiCard icon={RefreshIcon} color="orange" value={inventoryKpi?.reconstructPendingCount ?? "..."} label="再構築待ち" />
          <KpiCard icon={TrendUpIcon} color="green" value={inventoryKpi ? `${inventoryKpi.syncedRate}%` : "..."} label="同期済み率" />
        </div>

        <div className="inventory-charts-row">
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>チャネル別 在庫健全性</h2>
            {healthByChannel && (
              <InventoryHealthBar
                rows={[
                  { label: "BASE", bucket: healthByChannel.base },
                  { label: "eBay", bucket: healthByChannel.ebay },
                  { label: "中央在庫", bucket: healthByChannel.central },
                ]}
              />
            )}
          </div>
          <div className="card card-pad">
            <h2 style={{ marginBottom: "0.75rem" }}>在庫差分の推移(件数)</h2>
            <InventoryTrendChart data={trend} />
          </div>
        </div>

        <HowItWorksCard />

        <div className="inventory-main-layout">
          <div className="inventory-main-col">
            <InventoryTable
              products={products}
              total={total}
              loading={listLoading}
              q={q}
              onQChange={(v) => {
                setQ(v);
                setPage(1);
              }}
              diffStatus={diffStatus}
              onDiffStatusChange={(v) => {
                setDiffStatus(v);
                setPage(1);
              }}
              channel={channel}
              onChannelChange={(v) => {
                setChannel(v);
                setPage(1);
              }}
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
              onBulkReconstruct={handleBulkReconstruct}
              bulkReconstructing={bulkReconstructing}
              selectedProductId={selectedProductId}
              onSelectRow={selectRow}
            />
          </div>

          {selectedRow && (
            <div className="inventory-side-col">
              <ProductDetailPanel
                row={selectedRow}
                detail={detail}
                loading={detailLoading}
                activeTab={activeTab}
                onTabChange={setActiveTab}
                syncTrace={syncTrace}
                syncTraceLoading={syncTraceLoading}
                onExpandHistory={handleExpandHistory}
                historyExpanded={historyExpanded}
                reconstructPreview={reconstructPreview}
                checkingReconstruct={checkingReconstruct}
                applyingReconstruct={applyingReconstruct}
                onCheckReconstruct={handleCheckReconstruct}
                onApplyReconstruct={handleApplyReconstruct}
                possibleDoubleSaleErrorId={possibleDoubleSaleErrorId}
                onClose={() => setSelectedProductId(null)}
              />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
