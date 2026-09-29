import { EBAY_ITEM_CONDITIONS } from "@/lib/ai-draft-copy";
import type { AiListingDraftRow, DynamicPrice, PreflightCheck, ProductDetailRow } from "./types";
import { Badge } from "@/components/ui/Badge";

interface DraftEditorPanelProps {
  product: ProductDetailRow;
  draft: AiListingDraftRow;
  preflight: PreflightCheck | null;
  itemSpecifics: Record<string, string | null>;
  onItemSpecificChange: (key: string, value: string) => void;
  condition: string;
  onConditionChange: (value: string) => void;
  priceInput: string;
  onPriceChange: (value: string) => void;
  dynamicPrice: DynamicPrice | null;
  onSave: () => void;
  onApprove: () => void;
  saving: boolean;
  approving: boolean;
  dirty: boolean;
}

export function DraftEditorPanel({
  product,
  draft,
  preflight,
  itemSpecifics,
  onItemSpecificChange,
  condition,
  onConditionChange,
  priceInput,
  onPriceChange,
  dynamicPrice,
  onSave,
  onApprove,
  saving,
  approving,
  dirty,
}: DraftEditorPanelProps) {
  const priceNum = Number(priceInput);
  const referenceJpy = Number.isFinite(priceNum) && dynamicPrice ? Math.round(priceNum / dynamicPrice.fxRateUsdPerJpy) : null;
  const missingAspectsCount = preflight?.missingAspects.length ?? 0;

  return (
    <div className="draft-editor-panel">
      <div className="draft-editor-header">
        {product.images[0] ? (
          <img src={product.images[0]} alt="" className="draft-editor-thumb" />
        ) : (
          <div className="draft-editor-thumb draft-editor-thumb-empty" aria-hidden="true" />
        )}
        <div className="draft-editor-header-body">
          <h2>{product.title}</h2>
          <div className="draft-editor-meta">
            SKU: {product.sku} ・ 作成: {new Date(draft.createdAt).toLocaleString("ja-JP")}
          </div>
        </div>
      </div>

      {(missingAspectsCount > 0 || draft.sourceContentHash !== product.contentHash || draft.needsHumanReview) && (
        <div className="draft-editor-warnings">
          {missingAspectsCount > 0 && <Badge tone="error">必須項目不足({missingAspectsCount}件)</Badge>}
          {draft.sourceContentHash !== product.contentHash && <Badge tone="error">ソース内容不一致</Badge>}
          {draft.needsHumanReview && <Badge tone="warn">要確認</Badge>}
        </div>
      )}

      <section className="card card-pad">
        <div className="section-eyebrow">eBay タイトル(英語)</div>
        <p className="draft-editor-readonly-note">
          タイトル・説明文は現時点では編集できません。内容に誤りがある場合はBASE側の商品情報を修正し、再生成をお待ちください。
        </p>
        <h3>{draft.titleEn}</h3>
      </section>

      <section className="card card-pad">
        <div className="section-eyebrow">eBay 商品説明(HTML)</div>
        <div className="ai-description-preview" dangerouslySetInnerHTML={{ __html: draft.descriptionHtmlEn }} />
      </section>

      <section className="card card-pad">
        <div className="section-eyebrow">カテゴリ候補</div>
        {draft.categoryCandidates.length === 0 ? (
          <p className="draft-editor-readonly-note">カテゴリ候補がありません。</p>
        ) : (
          <ul className="draft-category-list">
            {draft.categoryCandidates.map((c, i) => (
              <li key={c.ebayCategoryId}>
                {c.label}
                {i === 0 && <Badge tone="info">使用中</Badge>}
              </li>
            ))}
          </ul>
        )}
        <p className="draft-editor-readonly-note">
          カテゴリの切り替えには現在対応していません。最初の候補が常に使用されます。
        </p>
      </section>

      <section className="card card-pad">
        <div className="section-eyebrow">商品詳細(Item Specifics)</div>
        <div className="specifics-grid">
          {Object.keys(itemSpecifics).map((key) => (
            <label key={key} className="specifics-field">
              <span>{key}</span>
              <input
                type="text"
                value={itemSpecifics[key] ?? ""}
                placeholder="未入力"
                onChange={(e) => onItemSpecificChange(key, e.target.value)}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="card card-pad">
        <div className="section-eyebrow">価格設定</div>
        <div className="draft-price-row">
          <label className="draft-price-field">
            <span>eBay販売価格(USD)</span>
            <input type="number" step="0.01" min="0" value={priceInput} onChange={(e) => onPriceChange(e.target.value)} />
          </label>
          <div className="draft-price-reference">
            <span>参考価格(JPY)</span>
            <strong>{referenceJpy != null ? `¥${referenceJpy.toLocaleString()}` : "—"}</strong>
          </div>
          {dynamicPrice && (
            <button type="button" className="secondary" onClick={() => onPriceChange(dynamicPrice.recommendedPriceUsd.toFixed(2))}>
              AI提案価格(${dynamicPrice.recommendedPriceUsd.toFixed(2)})を使用
            </button>
          )}
        </div>
      </section>

      <section className="card card-pad">
        <div className="section-eyebrow">コンディション</div>
        <select value={condition} onChange={(e) => onConditionChange(e.target.value)}>
          {EBAY_ITEM_CONDITIONS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </section>

      <div className="draft-action-bar">
        <button type="button" className="secondary" disabled title="この操作には現在対応していません(下書きを差し戻す機能は未実装です)">
          差し戻し
        </button>
        <button type="button" className="secondary" onClick={onSave} disabled={!dirty || saving}>
          {saving ? "保存中..." : "保存"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled
          title="この操作には現在対応していません(AI再生成は現状の冪等性キーの仕組み上、内容が変わらない限り新しい下書きを生成できません)"
        >
          再生成
        </button>
        <button type="button" className="button" onClick={onApprove} disabled={approving}>
          {approving ? "公開中..." : "承認して出品"}
        </button>
      </div>
    </div>
  );
}
