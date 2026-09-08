"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

interface ProductRow {
  productId: string;
  sku: string;
  title: string;
  status: string;
  images: string[];
  channelStatus: Record<string, string>;
  inventory: InventoryBreakdown | null;
  staleLevel: "fresh" | "stale_30" | "stale_60" | "stale_90";
}

const STATUS_BADGE: Record<string, string> = {
  draft: "badge",
  ai_generated: "badge warn",
  active: "badge ok",
  sold_out: "badge error",
  archived: "badge",
};

const STATUS_LABEL: Record<string, string> = {
  draft: "取込済み(未生成)",
  ai_generated: "AI生成済み・承認待ち",
  active: "eBay出品中",
  sold_out: "売り切れ",
  archived: "アーカイブ",
};

const CHANNEL_BADGE: Record<string, string> = {
  published: "badge ok",
  pending_approval: "badge warn",
  error: "badge error",
  update_pending: "badge warn",
  pending: "badge warn",
  delisted: "badge",
};

const CHANNEL_LABEL: Record<string, string> = {
  published: "出品中",
  pending_approval: "承認待ち",
  error: "要確認",
  update_pending: "更新中",
  pending: "準備中",
  delisted: "削除済み",
};

type FilterTab = "all" | "pending" | "active" | "attention";

const PAGE_SIZE = 30;

export default function ProductsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadedError, setLoadedError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<FilterTab>("all");

  async function load(requestedLimit: number) {
    if (requestedLimit === PAGE_SIZE) setLoading(true);
    else setLoadingMore(true);
    setLoadedError(false);
    try {
      const res = await apiGet<{ products: ProductRow[] }>(`/admin/commerce-dashboard?limit=${requestedLimit}`);
      setRows(res.products);
      // The backend returns a flat, bounded list (no cursor) -- if we got back exactly as
      // many rows as we asked for, there may be more; asking for one more than currently
      // shown is how "load more" is implemented below.
      setHasMore(res.products.length >= requestedLimit);
    } catch (err) {
      setLoadedError(true);
      notify(`商品一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    if (ready) void load(limit);
  }, [ready]);

  function loadMore() {
    const next = limit + PAGE_SIZE;
    setLimit(next);
    void load(next);
  }

  const pendingCount = rows.filter((r) => r.status === "ai_generated").length;
  const attentionCount = rows.filter((r) => r.channelStatus.base === "error" || r.channelStatus.ebay === "error").length;

  const filtered = useMemo(() => {
    let list = rows;
    if (tab === "pending") list = list.filter((r) => r.status === "ai_generated");
    else if (tab === "active") list = list.filter((r) => r.channelStatus.ebay === "published");
    else if (tab === "attention") list = list.filter((r) => r.channelStatus.base === "error" || r.channelStatus.ebay === "error");
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => r.title.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q));
    return list;
  }, [rows, tab, query]);

  return (
    <>
      <Topbar onSearch={setQuery} />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>商品マスター</h1>
            <p className="page-lead">
              eBayへの出品は必ず人間の承認が必要です。「AI生成済み・承認待ち」の商品を開いて内容を確認のうえ承認してください。BASEの商品は自動で取り込まれます(最短15分ごと)。
            </p>
          </div>
          <Link href="/products/link-existing" className="button secondary">
            既存eBay出品を紐付ける
          </Link>
        </div>

        <div className="filter-tabs" style={{ marginBottom: "1rem" }}>
          <button type="button" className="filter-tab" data-active={tab === "all"} onClick={() => setTab("all")}>
            全商品 {rows.length > 0 && `(${rows.length})`}
          </button>
          <button type="button" className="filter-tab" data-active={tab === "pending"} onClick={() => setTab("pending")}>
            承認待ち {pendingCount > 0 && `(${pendingCount})`}
          </button>
          <button type="button" className="filter-tab" data-active={tab === "active"} onClick={() => setTab("active")}>
            出品中
          </button>
          <button type="button" className="filter-tab" data-active={tab === "attention"} onClick={() => setTab("attention")}>
            要確認 {attentionCount > 0 && `(${attentionCount})`}
          </button>
        </div>

        {!ready || loading ? (
          <SkeletonRows />
        ) : loadedError ? (
          <div className="table-wrapper">
            <EmptyState>
              読み込みに失敗しました。
              <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => load(limit)}>
                再試行
              </button>
            </EmptyState>
          </div>
        ) : filtered.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>{query.trim() || tab !== "all" ? "該当する商品がありません。" : "商品がまだ登録されていません。"}</EmptyState>
          </div>
        ) : (
          <>
            <div className="product-card-list">
              {filtered.map((p) => (
                <Link key={p.productId} href={`/products/detail?id=${p.productId}`} className="product-card">
                  {p.images[0] ? (
                    <img src={p.images[0]} alt="" className="product-card-thumb" />
                  ) : (
                    <div className="product-card-thumb product-card-thumb-empty" aria-hidden="true" />
                  )}
                  <div className="product-card-body">
                    <div className="product-card-title">{p.title}</div>
                    <div className="product-card-sku">{p.sku}</div>
                    <div className="product-card-badges">
                      <span className={STATUS_BADGE[p.status] ?? "badge"}>{STATUS_LABEL[p.status] ?? p.status}</span>
                      {p.channelStatus.ebay && (
                        <span className={CHANNEL_BADGE[p.channelStatus.ebay] ?? "badge"}>
                          eBay: {CHANNEL_LABEL[p.channelStatus.ebay] ?? p.channelStatus.ebay}
                        </span>
                      )}
                    </div>
                    {p.inventory && (
                      <div className="product-card-stock">
                        手持在庫 {p.inventory.onHand}点
                        {" ・ "}
                        {Object.entries(p.inventory.sellableByChannel)
                          .map(([ch, qty]) => `${ch.toUpperCase()}販売可${qty}`)
                          .join(" / ")}
                      </div>
                    )}
                  </div>
                </Link>
              ))}
            </div>
            {hasMore && (
              <div style={{ textAlign: "center", marginTop: "1.25rem" }}>
                <button type="button" className="secondary" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "読み込み中..." : "もっと読み込む"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
