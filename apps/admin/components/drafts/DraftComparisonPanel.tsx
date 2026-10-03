import type { AiListingDraftRow, ChannelListingRow, ProductDetailRow } from "./types";

function formatJpy(value: number): string {
  return `¥${value.toLocaleString()}`;
}

function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface DraftComparisonPanelProps {
  product: ProductDetailRow;
  draft: AiListingDraftRow;
  ebayListing?: ChannelListingRow;
}

/** The image's side-by-side "BASEの元商品情報" / "AI生成したeBay出品内容" panel -- every
 *  field here is real (ProductMaster's own Japanese content vs. the AI draft's English
 *  content), no fabricated fields. "商品ページを開く" (a link to the BASE listing itself)
 *  is intentionally omitted: product_master has no stored BASE item URL to link to. */
export function DraftComparisonPanel({ product, draft, ebayListing }: DraftComparisonPanelProps) {
  const ebayPreviewUrl = ebayListing?.externalId ? `https://www.ebay.com/itm/${ebayListing.externalId}` : null;
  return (
    <div className="draft-compare-grid">
      <div className="draft-compare-col">
        <div className="draft-compare-col-title">BASEの元商品情報</div>
        {product.images[0] && <img src={product.images[0]} alt="" className="draft-compare-thumb" />}
        <dl className="kv-list">
          <div>
            <dt>商品名</dt>
            <dd>{product.title}</dd>
          </div>
          <div>
            <dt>SKU</dt>
            <dd>{product.sku}</dd>
          </div>
          <div>
            <dt>価格</dt>
            <dd>{formatJpy(product.priceJpy)}</dd>
          </div>
          <div>
            <dt>商品説明</dt>
            <dd>{product.descriptionJa || "—"}</dd>
          </div>
        </dl>
      </div>
      <div className="draft-compare-col">
        <div className="draft-compare-col-title">AI生成したeBay出品内容</div>
        {product.images[0] && <img src={product.images[0]} alt="" className="draft-compare-thumb" />}
        <dl className="kv-list">
          <div>
            <dt>商品名</dt>
            <dd>{draft.titleEn}</dd>
          </div>
          <div>
            <dt>価格</dt>
            <dd>{draft.suggestedPriceUsd != null ? formatUsdCents(draft.suggestedPriceUsd) : "未設定"}</dd>
          </div>
          <div>
            <dt>コンディション</dt>
            <dd>{draft.condition}</dd>
          </div>
          <div>
            <dt>商品説明</dt>
            <dd dangerouslySetInnerHTML={{ __html: draft.descriptionHtmlEn }} />
          </div>
        </dl>
        {ebayPreviewUrl && (
          <a href={ebayPreviewUrl} target="_blank" rel="noopener noreferrer" className="secondary draft-compare-preview-link">
            eBayプレビューで確認
          </a>
        )}
      </div>
    </div>
  );
}
