"use client";

import type { ProductMaster, SyncError } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function DashboardPage() {
  const { ready } = useRequireAuth();
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [syncErrors, setSyncErrors] = useState<SyncError[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    Promise.all([
      apiGet<{ products: ProductMaster[] }>("/admin/products"),
      apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors"),
    ])
      .then(([p, e]) => {
        setProducts(p.products);
        setSyncErrors(e.syncErrors);
      })
      .finally(() => setLoading(false));
  }, [ready]);

  if (!ready || loading) return <p>読み込み中...</p>;

  const pendingApproval = products.filter((p) => p.status === "ai_generated").length;
  const active = products.filter((p) => p.status === "active").length;
  const soldOut = products.filter((p) => p.status === "sold_out").length;

  return (
    <div>
      <h1>ダッシュボード</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "1rem", marginTop: "1rem" }}>
        <StatCard label="商品数" value={products.length} />
        <StatCard label="eBay出品承認待ち" value={pendingApproval} href="/products" />
        <StatCard label="出品中" value={active} />
        <StatCard label="売り切れ" value={soldOut} />
        <StatCard label="未解決の同期エラー" value={syncErrors.length} href="/sync-errors" danger={syncErrors.length > 0} />
      </div>
    </div>
  );
}

function StatCard({ label, value, href, danger }: { label: string; value: number; href?: string; danger?: boolean }) {
  const content = (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "1rem",
        color: danger ? "var(--danger)" : undefined,
      }}
    >
      <div style={{ fontSize: "1.75rem", fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: "0.85rem", color: "#666" }}>{label}</div>
    </div>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
