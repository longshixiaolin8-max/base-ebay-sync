import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { ORDER_STATUS_BADGE, ORDER_STATUS_LABEL } from "@/lib/order-copy";
import type { OrderRow } from "./types";

interface OrdersTableProps {
  orders: OrderRow[];
  total: number;
  loading: boolean;
  usdPerJpy: number | null;
  q: string;
  onQChange: (v: string) => void;
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  channel: string;
  onChannelChange: (v: string) => void;
  status: string;
  onStatusChange: (v: string) => void;
  profitStatus: string;
  onProfitStatusChange: (v: string) => void;
  onClearFilters: () => void;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  selectedOrderId: string | null;
  onSelectRow: (id: string) => void;
  onBulkFinalize: () => void;
  bulkFinalizing: boolean;
}

function jpy(n: number): string {
  return `¥${n.toLocaleString()}`;
}

function feesJpy(order: OrderRow, usdPerJpy: number): number {
  return Math.round(((order.ebayFeeUsdCents ?? 0) + (order.paymentFeeUsdCents ?? 0)) / 100 / usdPerJpy);
}

export function OrdersTable({
  orders,
  total,
  loading,
  usdPerJpy,
  q,
  onQChange,
  from,
  to,
  onFromChange,
  onToChange,
  channel,
  onChannelChange,
  status,
  onStatusChange,
  profitStatus,
  onProfitStatusChange,
  onClearFilters,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  selectedOrderId,
  onSelectRow,
  onBulkFinalize,
  bulkFinalizing,
}: OrdersTableProps) {
  // 利益状況 is not a server-side filter -- applied to the already-fetched page only, same
  // client-side-narrowing convention as the チャネル同期 job queue's channel filter.
  const visibleOrders = orders.filter((o) => {
    if (profitStatus === "finalized") return o.profit.finalized;
    if (profitStatus === "unfinalized") return !o.profit.finalized;
    if (profitStatus === "below_average") return o.belowAverageMargin;
    return true;
  });
  const allSelected = visibleOrders.length > 0 && visibleOrders.every((o) => selectedIds.has(o.id));

  return (
    <div className="card card-pad">
      <div className="orders-table-toolbar">
        <h2>注文一覧(全{total.toLocaleString()}件)</h2>
      </div>
      <div className="orders-table-filters">
        <input type="text" className="inventory-search-input" placeholder="注文ID・商品名・購入者名で検索..." value={q} onChange={(e) => onQChange(e.target.value)} />
        <div className="draft-date-range">
          <input type="date" value={from} onChange={(e) => onFromChange(e.target.value)} max={to} />〜
          <input type="date" value={to} onChange={(e) => onToChange(e.target.value)} min={from} />
        </div>
        <Select label="チャネル" value={channel} onChange={onChannelChange}>
          <option value="all">全チャネル</option>
          <option value="base">BASE</option>
          <option value="ebay">eBay</option>
        </Select>
        <Select label="ステータス" value={status} onChange={onStatusChange}>
          <option value="all">全ステータス</option>
          {Object.entries(ORDER_STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select label="利益状況" value={profitStatus} onChange={onProfitStatusChange}>
          <option value="all">利益状況(すべて)</option>
          <option value="finalized">確定済み</option>
          <option value="unfinalized">未確定</option>
          <option value="below_average">利益率低下</option>
        </Select>
        <button type="button" className="secondary" onClick={onClearFilters}>
          フィルタをクリア
        </button>
      </div>

      {selectedIds.size > 0 && (
        <div className="inventory-bulk-bar">
          <span>{selectedIds.size}件選択中</span>
          <button type="button" className="secondary" onClick={onBulkFinalize} disabled={bulkFinalizing}>
            {bulkFinalizing ? "確定中..." : "選択した注文の利益を一括確定"}
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : visibleOrders.length === 0 ? (
        <EmptyState>該当する注文はありません。</EmptyState>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>
                  <Checkbox checked={allSelected} onChange={onToggleSelectAll} label="すべて選択" labelHidden />
                </th>
                <th>注文ID</th>
                <th>商品</th>
                <th>チャネル</th>
                <th>数量</th>
                <th>販売価格</th>
                <th>原価</th>
                <th>手数料</th>
                <th>送料</th>
                <th>利益</th>
                <th>ステータス</th>
                <th>注文日時</th>
              </tr>
            </thead>
            <tbody>
              {visibleOrders.map((o) => (
                <tr key={o.id} data-active={o.id === selectedOrderId} onClick={() => onSelectRow(o.id)} style={{ cursor: "pointer" }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selectedIds.has(o.id)} onChange={() => onToggleSelect(o.id)} label={`${o.externalOrderId}を選択`} labelHidden />
                  </td>
                  <td>
                    {o.externalOrderId}
                    {o.hasPossibleDoubleSale && (
                      <div>
                        <Badge tone="error">重複の可能性</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <div className="inventory-row-product">
                      {o.product?.images[0] ? <img src={o.product.images[0]} alt="" className="inventory-row-thumb" /> : <div className="inventory-row-thumb inventory-row-thumb-empty" aria-hidden="true" />}
                      <div>
                        {o.product?.title ?? o.productId}
                        <div className="job-queue-sku">{o.product?.sku ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td>{o.channel === "ebay" ? "ebay" : "BASE"}</td>
                  <td>{o.quantity}</td>
                  <td>{usdPerJpy ? jpy(Math.round(o.profit.revenueUsdCents / 100 / usdPerJpy)) : "—"}</td>
                  <td>{o.costJpy != null ? jpy(o.costJpy) : "—"}</td>
                  <td>{usdPerJpy ? jpy(feesJpy(o, usdPerJpy)) : "—"}</td>
                  <td>{o.shippingCostJpy != null ? jpy(o.shippingCostJpy) : "—"}</td>
                  <td>
                    {usdPerJpy ? jpy(Math.round(o.profit.netProfitUsdCents / 100 / usdPerJpy)) : "—"}
                    {o.belowAverageMargin && (
                      <div>
                        <Badge tone="warn">利益率低下</Badge>
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={ORDER_STATUS_BADGE[o.status]}>{ORDER_STATUS_LABEL[o.status]}</span>
                  </td>
                  <td>{new Date(o.placedAt).toLocaleString("ja-JP")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} totalPages={Math.max(1, Math.ceil(total / pageSize))} onPageChange={onPageChange} pageSize={pageSize} onPageSizeChange={onPageSizeChange} totalCount={total} />
    </div>
  );
}
