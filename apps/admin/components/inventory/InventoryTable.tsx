import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Pagination } from "@/components/ui/Pagination";
import { Select } from "@/components/ui/Select";
import { relativeTime } from "@/lib/format";
import { DIFF_STATUS_LABEL, DIFF_STATUS_TONE, diffLabel } from "@/lib/inventory-copy";
import type { InventoryProductRow } from "./types";

interface InventoryTableProps {
  products: InventoryProductRow[];
  total: number;
  loading: boolean;
  q: string;
  onQChange: (v: string) => void;
  diffStatus: string;
  onDiffStatusChange: (v: string) => void;
  channel: string;
  onChannelChange: (v: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onBulkReconstruct: () => void;
  bulkReconstructing: boolean;
  selectedProductId: string | null;
  onSelectRow: (id: string) => void;
}

export function InventoryTable({
  products,
  total,
  loading,
  q,
  onQChange,
  diffStatus,
  onDiffStatusChange,
  channel,
  onChannelChange,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onBulkReconstruct,
  bulkReconstructing,
  selectedProductId,
  onSelectRow,
}: InventoryTableProps) {
  const allSelected = products.length > 0 && products.every((p) => selectedIds.has(p.id));

  return (
    <div className="card card-pad">
      <div className="inventory-table-toolbar">
        <h2>商品一覧({total.toLocaleString()}件)</h2>
        <div className="inventory-table-filters">
          <input type="text" className="inventory-search-input" placeholder="商品名・SKUで検索..." value={q} onChange={(e) => onQChange(e.target.value)} />
          <Select label="状態" value={diffStatus} onChange={onDiffStatusChange}>
            <option value="all">すべての状態</option>
            <option value="attention">要確認</option>
            <option value="possible_double_sale">possible_double_sale</option>
            <option value="sold_out">売り切れ</option>
          </Select>
          <Select label="チャネル" value={channel} onChange={onChannelChange}>
            <option value="all">すべてのチャネル</option>
            <option value="base">BASE</option>
            <option value="ebay">eBay</option>
          </Select>
          {/* この商品カタログにはカテゴリ体系が存在しないため(product_masterにカテゴリ列なし)、
              /products一覧と同じ規約で「表示はするが機能しない」フィルタとして残す。 */}
          <Select label="カテゴリ" value="all" onChange={() => {}} disabled>
            <option value="all">すべてのカテゴリ</option>
          </Select>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <div className="inventory-bulk-bar">
          <Checkbox checked={allSelected} onChange={onToggleSelectAll} label="すべて選択" />
          <button type="button" className="secondary" onClick={onBulkReconstruct} disabled={bulkReconstructing}>
            {bulkReconstructing ? "再構築中..." : `選択した商品を一括再構築(${selectedIds.size})`}
          </button>
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : products.length === 0 ? (
        <EmptyState>該当する商品はありません。</EmptyState>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>
                  <Checkbox checked={allSelected} onChange={onToggleSelectAll} label="すべて選択" labelHidden />
                </th>
                <th>商品</th>
                <th>SKU</th>
                <th>中央在庫</th>
                <th>BASE表示在庫</th>
                <th>eBay表示在庫</th>
                <th>safety stock</th>
                <th>差分判定</th>
                <th>最終同期</th>
                <th>状態</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} data-active={p.id === selectedProductId} onClick={() => onSelectRow(p.id)} style={{ cursor: "pointer" }}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selectedIds.has(p.id)} onChange={() => onToggleSelect(p.id)} label={`${p.title}を選択`} labelHidden />
                  </td>
                  <td>
                    <div className="inventory-row-product">
                      {p.images[0] ? <img src={p.images[0]} alt="" className="inventory-row-thumb" /> : <div className="inventory-row-thumb inventory-row-thumb-empty" aria-hidden="true" />}
                      {p.title}
                    </div>
                  </td>
                  <td>{p.sku}</td>
                  <td>{p.inventory?.onHand ?? "—"}</td>
                  <td>{p.inventory?.sellableByChannel.base ?? "—"}</td>
                  <td>{p.inventory?.sellableByChannel.ebay ?? "—"}</td>
                  <td>{p.safetyStockBuffer}</td>
                  <td>{diffLabel(p.diffStatus.code, p.diffStatus.diff)}</td>
                  <td>{p.lastSyncedAt ? relativeTime(p.lastSyncedAt) : "—"}</td>
                  <td>
                    <Badge tone={DIFF_STATUS_TONE[p.diffStatus.code] ?? "neutral"}>{DIFF_STATUS_LABEL[p.diffStatus.code] ?? p.diffStatus.code}</Badge>
                  </td>
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
