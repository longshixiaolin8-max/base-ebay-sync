"use client";

import type { ProductMaster } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";

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

export default function ProductsPage() {
  const { ready } = useRequireAuth();
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await apiGet<{ products: ProductMaster[] }>("/admin/products");
    setProducts(res.products);
    setLoading(false);
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function approve(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/admin/products/${id}/approve-ebay-listing`);
      await load();
    } catch (err) {
      alert(`承認に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!ready || loading) return <p>読み込み中...</p>;

  return (
    <div>
      <h1>商品マスター</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        eBayへの出品は必ず人間の承認が必要です。「AI生成済み・承認待ち」の商品はAIが生成した英語タイトル/説明を確認のうえ承認してください。
      </p>
      <table>
        <thead>
          <tr>
            <th>SKU</th>
            <th>商品名(BASE)</th>
            <th>価格(円)</th>
            <th>ステータス</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {products.map((p) => (
            <tr key={p.id}>
              <td>{p.sku}</td>
              <td>{p.title}</td>
              <td>{p.priceJpy.toLocaleString()}</td>
              <td>
                <span className={STATUS_BADGE[p.status] ?? "badge"}>{STATUS_LABEL[p.status] ?? p.status}</span>
              </td>
              <td>
                {p.status === "ai_generated" && (
                  <button onClick={() => approve(p.id)} disabled={busyId === p.id}>
                    {busyId === p.id ? "処理中..." : "承認してeBayへ出品"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
