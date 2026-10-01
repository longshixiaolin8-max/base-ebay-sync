"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useToast } from "@/components/Toast";
import { SkeletonRows } from "@/components/Skeleton";
import { Drawer } from "@/components/ui/Drawer";
import { Tabs } from "@/components/ui/Tabs";
import { Badge } from "@/components/ui/Badge";

interface ProductMasterRow {
  id: string;
  sku: string;
  title: string;
  descriptionJa: string;
  brand: string | null;
  material: string | null;
  sizeLabel: string | null;
  priceJpy: number;
  images: string[];
  status: string;
  costJpy: number | null;
  sourceChannel: string;
}

interface ChannelListingRow {
  channel: string;
  status: string;
  externalId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface AiListingDraftRow {
  id: string;
  titleEn: string;
  needsHumanReview: boolean;
  condition: string;
}

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

const PRODUCT_STATUS_LABEL: Record<string, string> = {
  draft: "取込済み(未生成)",
  ai_generated: "AI生成済み・承認待ち",
  active: "公開中",
  sold_out: "売り切れ",
  archived: "アーカイブ",
};

const CHANNEL_LISTING_LABEL: Record<string, string> = {
  published: "公開中",
  pending: "準備中",
  update_pending: "更新中",
  error: "要確認",
  delisted: "削除済み",
};

function formatJpy(value: number | null): string {
  return value == null ? "—" : `¥${value.toLocaleString()}`;
}

/**
 * A read-only quick-look drawer for one row of the products table -- built entirely from
 * GET /admin/products/{id} + GET /admin/products/{id}/inventory-breakdown, the same two
 * calls /products/detail already uses. Deliberately does NOT reimplement that page's ~700
 * lines of editing logic (purchase cost, pricing overrides, inventory reconstruction, sync
 * trace, AI draft correction) -- every section here links out to the real editor instead, so
 * there is exactly one place that logic lives.
 */
export function ProductPreviewDrawer({ productId, onClose }: { productId: string | null; onClose: () => void }) {
  const { notify } = useToast();
  const [loading, setLoading] = useState(false);
  const [product, setProduct] = useState<ProductMasterRow | null>(null);
  const [listings, setListings] = useState<ChannelListingRow[]>([]);
  const [draft, setDraft] = useState<AiListingDraftRow | null>(null);
  const [inventory, setInventory] = useState<InventoryBreakdown | null>(null);
  const [tab, setTab] = useState("basic");

  useEffect(() => {
    if (!productId) return;
    setLoading(true);
    setTab("basic");
    Promise.all([
      apiGet<{ product: ProductMasterRow; listings: ChannelListingRow[]; draft: AiListingDraftRow | null }>(`/admin/products/${productId}`),
      apiGet<InventoryBreakdown | null>(`/admin/products/${productId}/inventory-breakdown`).catch(() => null),
    ])
      .then(([detail, inv]) => {
        setProduct(detail.product);
        setListings(detail.listings);
        setDraft(detail.draft);
        setInventory(inv);
      })
      .catch((err) => notify(`商品情報の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [productId, notify]);

  const ebayListing = listings.find((l) => l.channel === "ebay");
  const baseListing = listings.find((l) => l.channel === "base");
  const editHref = productId ? `/products/detail?id=${productId}` : "#";

  return (
    <Drawer open={productId !== null} onClose={onClose} title={product?.title ?? "商品プレビュー"}>
      {loading || !product ? (
        <SkeletonRows count={4} />
      ) : (
        <>
          <div className="drawer-product-gallery">
            {product.images[0] ? (
              <img src={product.images[0]} alt="" className="drawer-product-hero" />
            ) : (
              <div className="drawer-product-hero drawer-product-hero-empty" aria-hidden="true" />
            )}
            {product.images.length > 1 && (
              <div className="drawer-product-thumbs">
                {product.images.slice(1, 4).map((src) => (
                  <img key={src} src={src} alt="" />
                ))}
                {product.images.length > 4 && <div className="drawer-product-thumb-more">+{product.images.length - 4}</div>}
              </div>
            )}
          </div>

          <div className="drawer-product-badges">
            <Badge tone={product.status === "active" ? "ok" : product.status === "sold_out" ? "error" : "neutral"}>
              {PRODUCT_STATUS_LABEL[product.status] ?? product.status}
            </Badge>
            {baseListing && <Badge tone="neutral">BASE</Badge>}
            {ebayListing && (
              <Badge
                tone={ebayListing.status === "published" ? "ok" : ebayListing.status === "error" ? "error" : "warn"}
                title={ebayListing.status === "error" ? (ebayListing.lastError ?? undefined) : undefined}
              >
                eBay: {CHANNEL_LISTING_LABEL[ebayListing.status] ?? ebayListing.status}
              </Badge>
            )}
          </div>

          <div className="drawer-product-sku">SKU: {product.sku}</div>

          <Tabs
            tabs={[
              { id: "basic", label: "基本情報" },
              { id: "pricing", label: "価格・在庫" },
              { id: "ai", label: "AI・同期" },
            ]}
            active={tab}
            onChange={setTab}
          />

          <div className="drawer-tab-panel">
            {tab === "basic" && (
              <dl className="kv-list">
                <div>
                  <dt>商品名</dt>
                  <dd>{product.title}</dd>
                </div>
                <div>
                  <dt>ブランド</dt>
                  <dd>{product.brand ?? "—"}</dd>
                </div>
                <div>
                  <dt>素材</dt>
                  <dd>{product.material ?? "—"}</dd>
                </div>
                <div>
                  <dt>サイズ</dt>
                  <dd>{product.sizeLabel ?? "—"}</dd>
                </div>
                <div>
                  <dt>元チャネル</dt>
                  <dd>{product.sourceChannel === "base" ? "BASE" : product.sourceChannel === "ebay" ? "eBay" : product.sourceChannel}</dd>
                </div>
                <div>
                  <dt>商品説明</dt>
                  <dd>{product.descriptionJa || "—"}</dd>
                </div>
              </dl>
            )}

            {tab === "pricing" && (
              <>
                <table className="drawer-mini-table">
                  <thead>
                    <tr>
                      <th>販売価格</th>
                      <th>原価</th>
                      <th>利益</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{formatJpy(product.priceJpy)}</td>
                      <td>{formatJpy(product.costJpy)}</td>
                      <td>
                        {product.costJpy != null
                          ? `${formatJpy(product.priceJpy - product.costJpy)} (${Math.round(((product.priceJpy - product.costJpy) / product.priceJpy) * 1000) / 10}%)`
                          : "原価未登録"}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <table className="drawer-mini-table" style={{ marginTop: "0.75rem" }}>
                  <thead>
                    <tr>
                      <th>在庫数</th>
                      <th>販売可能</th>
                      <th>セーフティ在庫</th>
                      <th>在庫管理</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{inventory ? inventory.onHand.toLocaleString() : "—"}</td>
                      <td>{inventory ? inventory.available.toLocaleString() : "—"}</td>
                      <td>{inventory ? inventory.safetyBuffer.toLocaleString() : "—"}</td>
                      <td>全チャネルで共有</td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}

            {tab === "ai" && (
              <dl className="kv-list">
                <div>
                  <dt>AI下書き</dt>
                  <dd>{draft ? draft.titleEn : "未生成"}</dd>
                </div>
                {draft && (
                  <>
                    <div>
                      <dt>コンディション</dt>
                      <dd>{draft.condition}</dd>
                    </div>
                    <div>
                      <dt>レビュー状態</dt>
                      <dd>{draft.needsHumanReview ? "要確認" : "確認済み"}</dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>BASE同期</dt>
                  <dd>{baseListing?.lastSyncedAt ? new Date(baseListing.lastSyncedAt).toLocaleString("ja-JP") : "—"}</dd>
                </div>
                <div>
                  <dt>eBay同期</dt>
                  <dd>{ebayListing?.lastSyncedAt ? new Date(ebayListing.lastSyncedAt).toLocaleString("ja-JP") : "—"}</dd>
                </div>
                {ebayListing?.status === "error" && ebayListing.lastError && (
                  <div>
                    <dt>eBayエラー内容</dt>
                    <dd style={{ color: "var(--color-error, #d33)", whiteSpace: "pre-wrap" }}>{ebayListing.lastError}</dd>
                  </div>
                )}
              </dl>
            )}
          </div>

          <Link href={editHref} className="button drawer-edit-link">
            詳細を編集
          </Link>
        </>
      )}
    </Drawer>
  );
}
