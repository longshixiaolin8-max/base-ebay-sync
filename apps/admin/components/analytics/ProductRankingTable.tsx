import Link from "next/link";
import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { Tabs } from "@/components/ui/Tabs";
import type { RankedProduct } from "./types";

const MEDALS = ["🥇", "🥈", "🥉"];

function confidenceTone(score: number): "ok" | "warn" | "error" {
  if (score >= 90) return "ok";
  if (score >= 70) return "warn";
  return "error";
}

export function ProductRankingTable({
  products,
  loading,
  sort,
  onSortChange,
  formatJpy,
}: {
  products: RankedProduct[];
  loading: boolean;
  sort: "revenue" | "profit" | "orders" | "turnover";
  onSortChange: (s: "revenue" | "profit" | "orders" | "turnover") => void;
  formatJpy: (jpy: number) => string;
}) {
  return (
    <div className="card card-pad">
      <div className="analytics-ranking-header">
        <h2>商品別ランキング TOP10</h2>
        <Tabs
          tabs={[
            { id: "revenue", label: "売上" },
            { id: "profit", label: "利益" },
            { id: "orders", label: "注文数" },
            { id: "turnover", label: "在庫回転" },
          ]}
          active={sort}
          onChange={(id) => onSortChange(id as typeof sort)}
        />
      </div>

      {loading ? (
        <SkeletonRows />
      ) : products.length === 0 ? (
        <EmptyState>この期間の注文データがありません。</EmptyState>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>商品</th>
                <th>売上</th>
                <th>利益</th>
                <th>注文数</th>
                <th>在庫回転</th>
                <th>同期信頼度</th>
                <th aria-label="アクション" />
              </tr>
            </thead>
            <tbody>
              {products.map((p, i) => (
                <tr key={p.productId}>
                  <td>{MEDALS[i] ?? i + 1}</td>
                  <td>
                    <div className="inventory-row-product">
                      {p.images[0] ? <img src={p.images[0]} alt="" className="inventory-row-thumb" /> : <div className="inventory-row-thumb inventory-row-thumb-empty" aria-hidden="true" />}
                      <div>
                        {p.title ?? p.productId}
                        <div className="job-queue-sku">{p.sku ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td>{formatJpy(p.revenueJpy)}</td>
                  <td>{formatJpy(p.profitJpy)}</td>
                  <td>{p.orderCount}</td>
                  <td>{p.turnoverRate != null ? `${p.turnoverRate}回/月` : "—"}</td>
                  <td>
                    <Badge tone={confidenceTone(p.syncConfidenceScore)}>{p.syncConfidenceScore}%</Badge>
                  </td>
                  <td>
                    <Link href={`/products/detail?id=${p.productId}`} className="secondary" style={{ display: "inline-block", textAlign: "center" }}>
                      詳細を見る
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
