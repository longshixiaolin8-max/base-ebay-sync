"use client";

import type { ProductMaster, SyncError } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";

export default function DashboardPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
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
      .catch((err) => notify(`ダッシュボードの取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [ready, notify]);

  const pendingApproval = products.filter((p) => p.status === "ai_generated").length;
  const active = products.filter((p) => p.status === "active").length;
  const soldOut = products.filter((p) => p.status === "sold_out").length;

  return (
    <div className="page">
      <div className="page-header">
        <h1>ダッシュボード</h1>
      </div>
      {!ready || loading ? (
        <SkeletonRows count={2} />
      ) : (
        <div className="stat-grid">
          <StatCard label="商品数" value={products.length} href="/products" />
          <StatCard label="eBay出品承認待ち" value={pendingApproval} href="/products" />
          <StatCard label="出品中" value={active} href="/commerce" />
          <StatCard label="売り切れ" value={soldOut} href="/products" />
          <StatCard
            label="未解決の同期エラー"
            value={syncErrors.length}
            href="/sync-errors"
            danger={syncErrors.length > 0}
          />
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, href, danger }: { label: string; value: number; href?: string; danger?: boolean }) {
  const content = (
    <>
      <div className={`stat-value${danger ? " danger" : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </>
  );
  return href ? (
    <Link href={href} className="stat-card">
      {content}
    </Link>
  ) : (
    <div className="stat-card">{content}</div>
  );
}
