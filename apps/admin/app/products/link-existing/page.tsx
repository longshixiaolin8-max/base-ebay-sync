"use client";

import type { ProductMaster } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface UnmanagedListing {
  externalId: string;
  title: string;
  suggestedProductId: string | null;
  matchScore?: number;
  matchReasons?: string[];
}

/**
 * 導入前からeBayに出品されていた商品(このプラットフォームがまだ知らない出品)を、
 * BASE側の商品と紐付ける画面。紐付けずに承認・出品を進めると、同じ商品が
 * product-fetch/ai-generate-worker経由で新規に重複出品されうる -- その事故を防ぐための
 * 唯一の導線。バックエンドの候補判定(GET /admin/ebay/unmanaged-listings)は既存実装を
 * そのまま使い、この画面は確認・実行のUIを提供するのみ。
 */
export default function LinkExistingListingsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [listings, setListings] = useState<UnmanagedListing[] | null>(null);
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [listingsRes, productsRes] = await Promise.all([
        apiGet<{ unmanagedListings: UnmanagedListing[] }>("/admin/ebay/unmanaged-listings"),
        apiGet<{ products: ProductMaster[] }>("/admin/products"),
      ]);
      setListings(listingsRes.unmanagedListings);
      setProducts(productsRes.products);
      setSelections((prev) => {
        const next = { ...prev };
        for (const l of listingsRes.unmanagedListings) {
          if (l.suggestedProductId && !(l.externalId in next)) next[l.externalId] = l.suggestedProductId;
        }
        return next;
      });
    } catch (err) {
      notify(`既存出品の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function link(externalId: string) {
    const productId = selections[externalId];
    if (!productId) {
      notify("紐付け先の商品を選択してください。");
      return;
    }
    setBusyId(externalId);
    try {
      await apiPost(`/admin/products/${productId}/link-ebay-listing`, { externalId });
      notify("既存のeBay出品を紐付けました。今後はこの商品として同期されます。", "success");
      await load();
    } catch (err) {
      notify(`紐付けに失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>既存eBay出品の紐付け</h1>
            <p className="page-lead">
              導入前からeBayに出品していた商品を、BASE側の商品と紐付けます。紐付けないまま出品を承認すると、同じ商品が重複して新規出品される可能性があります。候補は自動判定した参考情報です。必ず内容を確認してから紐付けてください。
            </p>
          </div>
          <Link href="/products" className="button secondary">
            商品マスターへ戻る
          </Link>
        </div>

        {!ready || loading ? (
          <SkeletonRows />
        ) : !listings || listings.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>紐付けが必要な出品は見つかりませんでした。eBayの出品はすべてこのプラットフォームで管理済みです。</EmptyState>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>eBayの出品</th>
                  <th>自動判定の候補</th>
                  <th>紐付け先</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {listings.map((l) => (
                  <tr key={l.externalId}>
                    <td>
                      {l.title}
                      <div style={{ fontSize: "0.78rem", color: "var(--fg-subtle)" }}>{l.externalId}</div>
                    </td>
                    <td>
                      {l.suggestedProductId ? (
                        <span className="badge ok">
                          候補あり{typeof l.matchScore === "number" ? `(一致度 ${Math.round(l.matchScore * 100)}%)` : ""}
                        </span>
                      ) : (
                        <span className="badge">候補なし</span>
                      )}
                      {l.matchReasons && l.matchReasons.length > 0 && (
                        <div style={{ fontSize: "0.76rem", color: "var(--fg-subtle)" }}>{l.matchReasons.join("・")}</div>
                      )}
                    </td>
                    <td>
                      <select
                        value={selections[l.externalId] ?? ""}
                        onChange={(e) => setSelections((s) => ({ ...s, [l.externalId]: e.target.value }))}
                      >
                        <option value="">選択してください</option>
                        {products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.title} ({p.sku})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button onClick={() => link(l.externalId)} disabled={busyId === l.externalId || !selections[l.externalId]}>
                        {busyId === l.externalId ? "処理中..." : "紐付ける"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
