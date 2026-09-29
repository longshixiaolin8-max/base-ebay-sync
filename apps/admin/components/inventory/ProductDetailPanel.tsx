import Link from "next/link";
import { Tabs } from "@/components/ui/Tabs";
import { LinkIcon } from "@/components/icons";
import { EventTimeline } from "./EventTimeline";
import type { InventoryProductRow, ProductDetail, SyncTraceEntry } from "./types";

interface ReconstructPreview {
  currentQuantity: number;
  reconstructedQuantity: number;
  drifted: boolean;
}

interface ProductDetailPanelProps {
  row: InventoryProductRow;
  detail: ProductDetail | null;
  loading: boolean;
  activeTab: "overview" | "history";
  onTabChange: (tab: "overview" | "history") => void;
  syncTrace: SyncTraceEntry[];
  syncTraceLoading: boolean;
  onExpandHistory: () => void;
  historyExpanded: boolean;
  reconstructPreview: ReconstructPreview | null;
  checkingReconstruct: boolean;
  applyingReconstruct: boolean;
  onCheckReconstruct: () => void;
  onApplyReconstruct: () => void;
  possibleDoubleSaleErrorId: string | null;
  onClose: () => void;
}

export function ProductDetailPanel({
  row,
  detail,
  loading,
  activeTab,
  onTabChange,
  syncTrace,
  syncTraceLoading,
  onExpandHistory,
  historyExpanded,
  reconstructPreview,
  checkingReconstruct,
  applyingReconstruct,
  onCheckReconstruct,
  onApplyReconstruct,
  possibleDoubleSaleErrorId,
  onClose,
}: ProductDetailPanelProps) {
  const categoryLabel = detail?.draft?.categoryCandidates[0]?.label ?? null;

  return (
    <div className="card inventory-detail-panel">
      <button type="button" className="icon-button inventory-detail-close" onClick={onClose} aria-label="閉じる">
        ✕
      </button>

      <div className="inventory-detail-header">
        {row.images[0] ? <img src={row.images[0]} alt="" className="inventory-detail-thumb" /> : <div className="inventory-detail-thumb inventory-detail-thumb-empty" aria-hidden="true" />}
        <div>
          <h3>{row.title}</h3>
          <div className="inventory-detail-meta">SKU: {row.sku}</div>
          {categoryLabel && <div className="inventory-detail-meta">{categoryLabel}</div>}
        </div>
        <Link href={`/products/detail?id=${row.id}`} className="icon-button" aria-label="商品詳細ページを開く" title="商品詳細ページを開く">
          <LinkIcon width={16} height={16} />
        </Link>
      </div>

      <Tabs
        tabs={[
          { id: "overview", label: "概要" },
          { id: "history", label: "イベント履歴" },
        ]}
        active={activeTab}
        onChange={(id) => onTabChange(id as "overview" | "history")}
      />

      {activeTab === "overview" ? (
        loading || !detail ? (
          <p className="inventory-detail-loading">読み込み中...</p>
        ) : (
          <div className="inventory-detail-overview">
            <dl className="inventory-detail-rows">
              <div>
                <dt>中央在庫</dt>
                <dd>{detail.inventory?.onHand ?? "—"}</dd>
              </div>
              <div>
                <dt>safety stock</dt>
                <dd>{row.safetyStockBuffer}</dd>
              </div>
              {detail.listings.map((l) => (
                <div key={l.channel}>
                  <dt>{l.channel === "base" ? "BASE" : "eBay"}表示在庫</dt>
                  <dd>{detail.inventory?.sellableByChannel[l.channel] ?? "—"}</dd>
                </div>
              ))}
            </dl>

            <div className="section-eyebrow" style={{ marginTop: "1rem" }}>
              在庫の再構築
            </div>
            <p className="inventory-detail-hint">イベント履歴から在庫数を再計算し、現在値とのズレがないか確認します。書き込みは「適用」を押すまで行われません。</p>
            {reconstructPreview && (
              <p className="inventory-detail-reconstruct-result">
                現在値 {reconstructPreview.currentQuantity} / 再計算値 {reconstructPreview.reconstructedQuantity}
                {reconstructPreview.drifted ? <span className="badge warn">ズレあり</span> : <span className="badge ok">一致</span>}
              </p>
            )}
            <div className="inventory-detail-actions">
              <button type="button" className="secondary" onClick={onCheckReconstruct} disabled={checkingReconstruct}>
                {checkingReconstruct ? "確認中..." : "差分を確認"}
              </button>
              {reconstructPreview?.drifted && (
                <button type="button" onClick={onApplyReconstruct} disabled={applyingReconstruct}>
                  {applyingReconstruct ? "適用中..." : "在庫再構築"}
                </button>
              )}
              <button
                type="button"
                className="secondary"
                disabled
                title="この操作には現在対応していません(在庫再構築と同じ処理のみが実装されており、別の即時再同期アクションは存在しません)"
              >
                チャネル在庫再同期
              </button>
            </div>

            {possibleDoubleSaleErrorId && (
              <Link href={`/sync-errors/detail?id=${possibleDoubleSaleErrorId}`} className="inventory-detail-alert-link">
                異常を確認(possible_double_saleの原因を分析します)
              </Link>
            )}
          </div>
        )
      ) : (
        <div className="inventory-detail-history">
          {syncTraceLoading ? (
            <p className="inventory-detail-loading">読み込み中...</p>
          ) : (
            <>
              <EventTimeline entries={syncTrace} />
              {!historyExpanded && syncTrace.length >= 20 && (
                <button type="button" className="secondary" onClick={onExpandHistory}>
                  イベント履歴をすべて見る
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
