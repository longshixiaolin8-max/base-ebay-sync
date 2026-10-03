import Link from "next/link";
import { EmptyState } from "@/components/Skeleton";
import { Tabs } from "@/components/ui/Tabs";
import { LinkIcon } from "@/components/icons";
import { isOrderStatusTerminal, ORDER_STATUS_BADGE, ORDER_STATUS_LABEL, validNextOrderStatuses } from "@/lib/order-copy";
import { OrderTimeline } from "./OrderTimeline";
import type { OrderRow } from "./types";
import type { OrderStatus } from "@ai-ec/core";

export interface ExtraFields {
  shippingCostJpy: string;
  ebayFeeUsdCents: string;
  paymentFeeUsdCents: string;
  adSpendUsdCents: string;
  fxCostUsdCents: string;
  returnAmountUsdCents: string;
}

interface OrderDetailPanelProps {
  order: OrderRow;
  usdPerJpy: number | null;
  avgProfitMarginBasisPoints: number | null;
  activeTab: "info" | "customer" | "profit" | "timeline";
  onTabChange: (tab: "info" | "customer" | "profit" | "timeline") => void;
  nextStatus: OrderStatus | null;
  onNextStatusChange: (status: OrderStatus | null) => void;
  extra: ExtraFields;
  onExtraChange: (extra: ExtraFields) => void;
  onSubmitStatusChange: () => void;
  onFinalizeProfit: () => void;
  busy: boolean;
  onClose: () => void;
}

function jpy(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function pct(bps: number | null): string {
  return bps === null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

export function OrderDetailPanel({
  order,
  usdPerJpy,
  avgProfitMarginBasisPoints,
  activeTab,
  onTabChange,
  nextStatus,
  onNextStatusChange,
  extra,
  onExtraChange,
  onSubmitStatusChange,
  onFinalizeProfit,
  busy,
  onClose,
}: OrderDetailPanelProps) {
  const nextOptions = validNextOrderStatuses(order.status);
  const revenueJpy = usdPerJpy ? Math.round(order.profit.revenueUsdCents / 100 / usdPerJpy) : null;
  const feesJpy = usdPerJpy ? Math.round(((order.ebayFeeUsdCents ?? 0) + (order.paymentFeeUsdCents ?? 0)) / 100 / usdPerJpy) : null;
  const netProfitJpy = usdPerJpy ? Math.round(order.profit.netProfitUsdCents / 100 / usdPerJpy) : null;

  return (
    <div className="card inventory-detail-panel">
      <button type="button" className="icon-button inventory-detail-close" onClick={onClose} aria-label="閉じる">
        ✕
      </button>

      <div className="inventory-detail-header">
        {order.product?.images[0] ? <img src={order.product.images[0]} alt="" className="inventory-detail-thumb" /> : <div className="inventory-detail-thumb inventory-detail-thumb-empty" aria-hidden="true" />}
        <div>
          <div style={{ display: "flex", gap: "0.4rem", alignItems: "center", flexWrap: "wrap" }}>
            <h3>{order.externalOrderId}</h3>
            <span className={ORDER_STATUS_BADGE[order.status]}>{ORDER_STATUS_LABEL[order.status]}</span>
          </div>
          <div className="inventory-detail-meta">{order.channel === "ebay" ? "eBay注文" : "BASE注文"}</div>
          <div className="inventory-detail-meta">
            {order.product?.title ?? order.productId} ・ SKU: {order.product?.sku ?? "—"}
          </div>
        </div>
        <Link href={`/products/detail?id=${order.productId}`} className="icon-button" aria-label="商品詳細ページを開く" title="商品詳細ページを開く">
          <LinkIcon width={16} height={16} />
        </Link>
      </div>

      {order.belowAverageMargin && (
        <div className="order-margin-alert">
          利益率がやや低下しています
          <p>
            この注文の利益率({pct(order.profit.profitMarginBasisPoints)})は、直近の注文の平均利益率({pct(avgProfitMarginBasisPoints)})と比べて低くなっています。
          </p>
        </div>
      )}

      <Tabs
        tabs={[
          { id: "info", label: "注文情報" },
          { id: "customer", label: "顧客情報" },
          { id: "profit", label: "コスト・利益" },
          { id: "timeline", label: "タイムライン" },
        ]}
        active={activeTab}
        onChange={(id) => onTabChange(id as typeof activeTab)}
      />

      {activeTab === "info" && (
        <div className="inventory-detail-overview">
          <dl className="inventory-detail-rows">
            <div>
              <dt>注文ID</dt>
              <dd>{order.externalOrderId}</dd>
            </div>
            <div>
              <dt>注文日時</dt>
              <dd>{new Date(order.placedAt).toLocaleString("ja-JP")}</dd>
            </div>
            <div>
              <dt>チャネル</dt>
              <dd>{order.channel === "ebay" ? "eBay(海外マーケット)" : "BASE(自社ストア)"}</dd>
            </div>
            <div>
              <dt>数量</dt>
              <dd>{order.quantity}</dd>
            </div>
          </dl>
          <p className="inventory-detail-hint">支払い方法・配送方法・追跡番号は現在記録されていません。</p>

          {!order.profitFinalizedAt && (
            <>
              <div className="section-eyebrow" style={{ marginTop: "1rem" }}>
                状態を更新
              </div>
              {isOrderStatusTerminal(order.status) ? (
                <p className="inventory-detail-hint">この注文はこれ以上状態を進められません。</p>
              ) : (
                <div className="inventory-detail-actions">
                  {nextOptions.map((s) => (
                    <button key={s} type="button" className={nextStatus === s ? "" : "secondary"} onClick={() => onNextStatusChange(s)}>
                      {ORDER_STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}

              {nextStatus && (
                <div style={{ marginTop: "0.75rem" }}>
                  <div className="specifics-grid">
                    <label className="specifics-field">
                      <span>送料(JPY)</span>
                      <input type="text" inputMode="numeric" value={extra.shippingCostJpy} onChange={(e) => onExtraChange({ ...extra, shippingCostJpy: e.target.value })} />
                    </label>
                    <label className="specifics-field">
                      <span>eBay手数料(USD)</span>
                      <input type="text" inputMode="decimal" value={extra.ebayFeeUsdCents} onChange={(e) => onExtraChange({ ...extra, ebayFeeUsdCents: e.target.value })} />
                    </label>
                    <label className="specifics-field">
                      <span>決済手数料(USD)</span>
                      <input type="text" inputMode="decimal" value={extra.paymentFeeUsdCents} onChange={(e) => onExtraChange({ ...extra, paymentFeeUsdCents: e.target.value })} />
                    </label>
                    <label className="specifics-field">
                      <span>広告費(USD)</span>
                      <input type="text" inputMode="decimal" value={extra.adSpendUsdCents} onChange={(e) => onExtraChange({ ...extra, adSpendUsdCents: e.target.value })} />
                    </label>
                    <label className="specifics-field">
                      <span>為替コスト(USD)</span>
                      <input type="text" inputMode="decimal" value={extra.fxCostUsdCents} onChange={(e) => onExtraChange({ ...extra, fxCostUsdCents: e.target.value })} />
                    </label>
                    {(nextStatus === "RETURNED" || order.status === "RETURN_REQUESTED") && (
                      <label className="specifics-field">
                        <span>返金額(USD)</span>
                        <input type="text" inputMode="decimal" value={extra.returnAmountUsdCents} onChange={(e) => onExtraChange({ ...extra, returnAmountUsdCents: e.target.value })} />
                      </label>
                    )}
                  </div>
                  <button type="button" style={{ marginTop: "0.75rem" }} onClick={onSubmitStatusChange} disabled={busy}>
                    {busy ? "更新中..." : `「${ORDER_STATUS_LABEL[nextStatus]}」に更新`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {activeTab === "customer" && (
        <div className="inventory-detail-overview">
          <EmptyState>
            購入者名・配送先住所は現在記録されていません。BASE/eBayの注文Webhookが購入者情報を渡していても、このプラットフォームはまだ保存していません。
          </EmptyState>
        </div>
      )}

      {activeTab === "profit" && (
        <div className="inventory-detail-overview">
          <div className="section-eyebrow">コスト・利益サマリー</div>
          <dl className="inventory-detail-rows order-profit-summary">
            <div>
              <dt>販売価格{order.quantity > 1 ? `(${order.quantity}点)` : ""}</dt>
              <dd>{revenueJpy !== null ? jpy(revenueJpy) : "—"}</dd>
            </div>
            <div>
              <dt>原価</dt>
              <dd>{order.costJpy != null ? jpy(order.costJpy) : "—"}</dd>
            </div>
            <div>
              <dt>販売手数料</dt>
              <dd>{feesJpy !== null ? jpy(feesJpy) : "—"}</dd>
            </div>
            <div>
              <dt>送料</dt>
              <dd>{order.shippingCostJpy != null ? jpy(order.shippingCostJpy) : "—"}</dd>
            </div>
            <div className="order-profit-highlight">
              <dt>{order.profit.finalized ? "確定利益" : "粗利(見込み)"}</dt>
              <dd>{netProfitJpy !== null ? jpy(netProfitJpy) : "—"}</dd>
            </div>
            <div className="order-profit-highlight">
              <dt>利益率</dt>
              <dd>{pct(order.profit.profitMarginBasisPoints)}</dd>
            </div>
          </dl>

          {!order.profitFinalizedAt && (
            <button type="button" className="secondary" style={{ marginTop: "0.9rem" }} onClick={onFinalizeProfit} disabled={busy}>
              {busy ? "処理中..." : "利益を確定する"}
            </button>
          )}
        </div>
      )}

      {activeTab === "timeline" && (
        <div className="inventory-detail-overview">
          <OrderTimeline order={order} />
        </div>
      )}
    </div>
  );
}
