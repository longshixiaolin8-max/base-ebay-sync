"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { MoreIcon } from "@/components/icons";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Pagination } from "@/components/ui/Pagination";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import { BoxIcon, TagIcon, FileIcon, CartIcon, AlertIcon } from "@/components/icons";
import { ProductPreviewDrawer } from "@/components/products/ProductPreviewDrawer";

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

interface ProductListRow {
  id: string;
  sku: string;
  title: string;
  sourceChannel: string;
  status: string;
  images: string[];
  priceJpy: number;
  costJpy: number | null;
  ebayListingStatus: string | null;
  inventory: InventoryBreakdown | null;
  aiDraftCount: number;
  updatedAt: string;
}

interface ProductListResponse {
  products: ProductListRow[];
  total: number;
  kpi: { total: number; published: number; draft: number; soldOut: number; needsAttention: number };
}

const STATUS_LABEL: Record<string, string> = {
  draft: "取込済み",
  ai_generated: "下書き",
  active: "公開中",
  sold_out: "売り切れ",
  archived: "アーカイブ",
};

const EBAY_STATUS_LABEL: Record<string, string> = {
  pending: "下書き",
  published: "公開中",
  update_pending: "更新中",
  error: "エラー(要修正)",
  delisted: "削除済み",
};

const EBAY_STATUS_TONE: Record<string, "neutral" | "ok" | "warn" | "error"> = {
  pending: "warn",
  published: "ok",
  update_pending: "warn",
  error: "error",
  delisted: "neutral",
};

function formatJpy(value: number): string {
  return `¥${value.toLocaleString()}`;
}

function ProductsPageInner() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  // Lets other pages deep-link into a pre-filtered view (e.g. the dashboard's "AI出品下書き"
  // alert links to /products?status=ai_generated) instead of landing on the unfiltered table.
  const searchParams = useSearchParams();
  const [data, setData] = useState<ProductListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(() => searchParams.get("status") ?? "");
  const [channel, setChannel] = useState(() => searchParams.get("channel") ?? "");
  const [syncStatus, setSyncStatus] = useState(() => searchParams.get("syncStatus") ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const params = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize) });
      if (query.trim()) params.set("q", query.trim());
      if (status) params.set("status", status);
      if (channel) params.set("channel", channel);
      if (syncStatus) params.set("syncStatus", syncStatus);
      const res = await apiGet<ProductListResponse>(`/admin/products/list?${params.toString()}`);
      setData(res);
    } catch (err) {
      setLoadError(true);
      notify(`商品一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, query, status, channel, syncStatus, notify]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  // Any filter/search change re-queries from page 1 -- staying on e.g. page 5 of a filter
  // that now has 2 matching pages would just show an empty page.
  useEffect(() => {
    setPage(1);
  }, [query, status, channel, syncStatus, pageSize]);

  const rows = data?.products ?? [];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / pageSize)) : 1;
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleAll(checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (checked) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // Real action, looped client-side over the existing single-product endpoint -- there is no
  // dedicated bulk-approve API. Only attempted for rows that actually have a non-published
  // eBay listing to approve; others are silently skipped rather than sent to an endpoint that
  // would just 404/409 them.
  async function bulkApprove() {
    const targets = rows.filter((r) => selected.has(r.id) && r.ebayListingStatus && r.ebayListingStatus !== "published");
    if (targets.length === 0) {
      notify("選択した商品の中に承認待ちのeBay出品がありません。");
      return;
    }
    setBulkRunning(true);
    let succeeded = 0;
    let failed = 0;
    for (const t of targets) {
      try {
        await apiPost(`/admin/products/${t.id}/approve-ebay-listing`, {});
        succeeded++;
      } catch {
        failed++;
      }
    }
    setBulkRunning(false);
    setSelected(new Set());
    notify(failed > 0 ? `${succeeded}件承認しました(${failed}件失敗)。` : `${succeeded}件承認しました。`);
    void load();
  }

  const selectedCount = selected.size;

  return (
    <>
      <Topbar searchPlaceholder="商品名・SKU・説明文で検索..." />
      <div className="page page-wide">
        <PageHeader
          title="商品マスター"
          lead="BASEとeBayの商品を一元管理し、AIでの商品最適化・多チャネル展開を効率化します。"
          actions={
            <Link href="/products/link-existing" className="button">
              既存eBay出品を紐付ける
            </Link>
          }
        />

        {!ready || (loading && !data) ? (
          <SkeletonRows count={4} />
        ) : loadError ? (
          <div className="table-wrapper">
            <EmptyState>
              読み込みに失敗しました。
              <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => void load()}>
                再試行
              </button>
            </EmptyState>
          </div>
        ) : (
          data && (
            <>
              <div className="kpi-grid">
                <KpiCard icon={BoxIcon} color="blue" value={data.kpi.total.toLocaleString()} label="総商品数" />
                <KpiCard icon={TagIcon} color="green" value={data.kpi.published.toLocaleString()} label="出品済み" />
                <KpiCard icon={FileIcon} color="purple" value={data.kpi.draft.toLocaleString()} label="下書き" />
                <KpiCard icon={CartIcon} color="orange" value={data.kpi.soldOut.toLocaleString()} label="売り切れ" />
                <KpiCard
                  icon={AlertIcon}
                  color={data.kpi.needsAttention > 0 ? "red" : "green"}
                  value={data.kpi.needsAttention.toLocaleString()}
                  label="要修正"
                  href="/sync-errors"
                />
              </div>

              <div className="products-filter-bar">
                <label className="products-search">
                  <input type="text" placeholder="商品名・SKUで検索..." value={query} onChange={(e) => setQuery(e.target.value)} />
                </label>
                <Select label="カテゴリ" value="" onChange={() => {}} disabled>
                  <option value="">すべて</option>
                </Select>
                <Select label="販売チャネル" value={channel} onChange={setChannel}>
                  <option value="">すべて</option>
                  <option value="base">BASE</option>
                  <option value="ebay">eBay</option>
                </Select>
                <Select label="ステータス" value={status} onChange={setStatus}>
                  <option value="">すべて</option>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <Select label="同期ステータス" value={syncStatus} onChange={setSyncStatus}>
                  <option value="">すべて</option>
                  {Object.entries(EBAY_STATUS_LABEL).map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </Select>
                <div className="products-bulk-bar">
                  <span>選択した{selectedCount}件</span>
                  <DropdownMenu
                    label="一括操作"
                    trigger={
                      <span className="secondary products-bulk-trigger" data-disabled={selectedCount === 0}>
                        一括操作
                      </span>
                    }
                  >
                    <button type="button" className="dropdown-menu-item" disabled={selectedCount === 0 || bulkRunning} onClick={bulkApprove}>
                      {bulkRunning ? "承認中..." : "選択したeBay出品を一括承認"}
                    </button>
                  </DropdownMenu>
                </div>
              </div>

              {rows.length === 0 ? (
                <div className="table-wrapper">
                  <EmptyState>該当する商品がありません。</EmptyState>
                </div>
              ) : (
                <div className="table-wrapper">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: "2rem" }}>
                          <Checkbox checked={allOnPageSelected} onChange={toggleAll} label="このページの商品をすべて選択" labelHidden />
                        </th>
                        <th>商品</th>
                        <th>SKU</th>
                        <th>元チャネル</th>
                        <th>価格</th>
                        <th>原価</th>
                        <th>在庫</th>
                        <th>eBay公開状況</th>
                        <th>AI下書き</th>
                        <th>最終更新</th>
                        <th aria-label="アクション" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id} className="products-table-row" onClick={() => setPreviewId(r.id)}>
                          <td onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={selected.has(r.id)} onChange={(c) => toggleOne(r.id, c)} label={`${r.title}を選択`} labelHidden />
                          </td>
                          <td>
                            <div className="products-table-title-cell">
                              {r.images[0] ? (
                                <img src={r.images[0]} alt="" className="products-table-thumb" />
                              ) : (
                                <div className="products-table-thumb products-table-thumb-empty" aria-hidden="true" />
                              )}
                              <span>{r.title}</span>
                            </div>
                          </td>
                          <td>{r.sku}</td>
                          <td>
                            <Badge tone="neutral">{r.sourceChannel === "base" ? "BASE" : r.sourceChannel === "ebay" ? "eBay" : r.sourceChannel}</Badge>
                          </td>
                          <td>{formatJpy(r.priceJpy)}</td>
                          <td>{r.costJpy != null ? formatJpy(r.costJpy) : "—"}</td>
                          <td>{r.inventory ? r.inventory.available.toLocaleString() : "—"}</td>
                          <td>
                            {r.ebayListingStatus ? (
                              <Badge tone={EBAY_STATUS_TONE[r.ebayListingStatus] ?? "neutral"}>
                                {EBAY_STATUS_LABEL[r.ebayListingStatus] ?? r.ebayListingStatus}
                              </Badge>
                            ) : (
                              <Badge tone="neutral">未出品</Badge>
                            )}
                          </td>
                          <td>{r.aiDraftCount > 0 ? `下書きあり(${r.aiDraftCount}件)` : "—"}</td>
                          <td style={{ whiteSpace: "nowrap", color: "var(--fg-subtle)", fontSize: "0.8rem" }}>{relativeTime(r.updatedAt)}</td>
                          <td onClick={(e) => e.stopPropagation()}>
                            <DropdownMenu label={`${r.title}のアクション`} trigger={<MoreIcon />}>
                              <button type="button" className="dropdown-menu-item" onClick={() => setPreviewId(r.id)}>
                                プレビュー
                              </button>
                              <Link href={`/products/detail?id=${r.id}`} className="dropdown-menu-item">
                                詳細を編集
                              </Link>
                            </DropdownMenu>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <Pagination page={page} totalPages={totalPages} onPageChange={setPage} pageSize={pageSize} onPageSizeChange={setPageSize} totalCount={data.total} />
            </>
          )
        )}
      </div>
      <ProductPreviewDrawer productId={previewId} onClose={() => setPreviewId(null)} />
    </>
  );
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<SkeletonRows count={4} />}>
      <ProductsPageInner />
    </Suspense>
  );
}
