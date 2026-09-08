"use client";

import type { SyncError } from "@ai-ec/core";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { ERROR_CODE_LABEL } from "@/lib/sync-error-copy";

interface InventoryBreakdown {
  onHand: number;
  available: number;
  sellableByChannel: Record<string, number>;
}

function SyncErrorDetailInner() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [error, setError] = useState<SyncError | null>(null);
  const [productTitle, setProductTitle] = useState<string | null>(null);
  const [inventory, setInventory] = useState<InventoryBreakdown | null>(null);
  const [history, setHistory] = useState<SyncError[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      // No single-item GET exists for a sync error -- it is only ever returned as part of
      // the list, so the detail view re-fetches both resolved states and finds this one.
      const [unresolved, resolved] = await Promise.all([
        apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false"),
        apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=true"),
      ]);
      const all = [...unresolved.syncErrors, ...resolved.syncErrors];
      const found = all.find((e) => e.id === id) ?? null;
      setError(found);

      if (found?.productId) {
        const [productRes, breakdown, unresolvedForProduct, resolvedForProduct] = await Promise.all([
          apiGet<{ product: { title: string; sku: string } }>(`/admin/products/${found.productId}`).catch(() => null),
          apiGet<InventoryBreakdown>(`/admin/products/${found.productId}/inventory-breakdown`).catch(() => null),
          apiGet<{ syncErrors: SyncError[] }>(`/admin/sync-errors?resolved=false&productId=${found.productId}`).catch(() => ({
            syncErrors: [],
          })),
          apiGet<{ syncErrors: SyncError[] }>(`/admin/sync-errors?resolved=true&productId=${found.productId}`).catch(() => ({
            syncErrors: [],
          })),
        ]);
        setProductTitle(productRes ? `${productRes.product.title}` : null);
        setInventory(breakdown);
        setHistory(
          [...unresolvedForProduct.syncErrors, ...resolvedForProduct.syncErrors]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            .slice(0, 10),
        );
      }
    } catch (err) {
      setLoadFailed(true);
      notify(`読み込みに失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [id, notify]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  async function retry() {
    if (!error || retrying) return;
    setRetrying(true);
    try {
      await apiPost(`/admin/sync-errors/${error.id}/retry`);
      notify("再試行をキューに登録しました。", "success");
      await load();
    } catch (err) {
      notify(`再試行の登録に失敗しました: ${(err as Error).message}`);
    } finally {
      setRetrying(false);
    }
  }

  async function reconnect(channel: "base" | "ebay") {
    setReconnecting(true);
    try {
      const res = await apiGet<{ url: string }>(`/admin/oauth/${channel}/authorize-url`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      notify(`連携の開始に失敗しました: ${(err as Error).message}`);
    } finally {
      setReconnecting(false);
    }
  }

  const copy = error ? ERROR_CODE_LABEL[error.errorCode] : undefined;

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <button type="button" className="button secondary" onClick={() => router.push("/sync-errors")}>
            ← 一覧へ戻る
          </button>
        </div>

        {!ready || loading ? (
          <SkeletonRows />
        ) : loadFailed || !error ? (
          <div className="table-wrapper" style={{ padding: "2rem", textAlign: "center", color: "var(--fg-subtle)" }}>
            {loadFailed ? (
              <>
                読み込みに失敗しました。
                <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => load()}>
                  再試行
                </button>
              </>
            ) : (
              "このエラーは見つかりませんでした(既に解決済みで一覧から外れた可能性があります)。"
            )}
          </div>
        ) : (
          <div className="detail-doc">
            <section className="card card-pad">
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
                <span className={error.resolved ? "badge ok" : "badge error"}>{error.resolved ? "解決済み" : "要確認"}</span>
                {error.channel && <span className="badge">{error.channel.toUpperCase()}</span>}
              </div>
              <h2 style={{ margin: "0.5rem 0 0.2rem" }}>{copy?.title ?? error.errorCode}</h2>
              {productTitle && <div style={{ color: "var(--fg-muted)", fontSize: "0.85rem" }}>{productTitle}</div>}
              <div style={{ fontSize: "0.76rem", color: "var(--fg-subtle)", marginTop: "0.3rem" }}>
                発生日時 {new Date(error.createdAt).toLocaleString("ja-JP")}
              </div>
            </section>

            {inventory && (
              <section className="card card-pad">
                <div className="section-eyebrow">現在の在庫</div>
                <div className="detail-metric-grid">
                  <div className="detail-metric">
                    <div className="detail-metric-value">{inventory.onHand}</div>
                    <div className="detail-metric-label">手持在庫</div>
                  </div>
                  <div className="detail-metric">
                    <div className="detail-metric-value">{inventory.available}</div>
                    <div className="detail-metric-label">販売可能</div>
                  </div>
                </div>
                <p style={{ fontSize: "0.78rem", color: "var(--fg-subtle)" }}>
                  {Object.entries(inventory.sellableByChannel)
                    .map(([ch, qty]) => `${ch.toUpperCase()}販売可 ${qty}点`)
                    .join(" / ")}
                </p>
              </section>
            )}

            <section className="card card-pad">
              <div className="section-eyebrow">原因</div>
              <p style={{ margin: "0.4rem 0" }}>{copy?.cause ?? "このエラーコードの詳細な説明はまだ用意されていません。"}</p>
            </section>

            <section className="card card-pad">
              <div className="section-eyebrow">推奨する対応手順</div>
              <ol style={{ margin: "0.5rem 0 0", paddingLeft: "1.3rem" }}>
                {(copy?.steps ?? ["技術的な詳細を確認し、解決しない場合はサポートにご連絡ください。"]).map((step, i) => (
                  <li key={i} style={{ marginBottom: "0.3rem" }}>
                    {step}
                  </li>
                ))}
              </ol>
              <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0, marginTop: "0.9rem" }}>
                {copy?.reconnectChannel && (
                  <button type="button" className="secondary" onClick={() => reconnect(copy.reconnectChannel!)} disabled={reconnecting}>
                    {reconnecting ? "処理中..." : `${copy.reconnectChannel === "base" ? "BASE" : "eBay"}に再接続`}
                  </button>
                )}
                {copy?.actionHref && (
                  <Link href={copy.actionHref} className="button secondary">
                    {copy.actionLabel}
                  </Link>
                )}
                {error.jobId && (copy?.retryable ?? true) && !error.resolved && (
                  <button type="button" onClick={retry} disabled={retrying}>
                    {retrying ? "処理中..." : "再試行"}
                  </button>
                )}
              </div>
            </section>

            {history.length > 0 && (
              <section className="card card-pad">
                <div className="section-eyebrow">最近の試行履歴</div>
                <ul style={{ margin: "0.5rem 0 0", padding: 0, listStyle: "none" }}>
                  {history.map((h) => (
                    <li
                      key={h.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        padding: "0.4rem 0",
                        borderBottom: "1px solid var(--border)",
                        fontSize: "0.85rem",
                      }}
                    >
                      <span>{h.resolved ? "✓" : "✕"} {ERROR_CODE_LABEL[h.errorCode]?.title ?? h.errorCode}</span>
                      <span style={{ color: "var(--fg-subtle)" }}>{new Date(h.createdAt).toLocaleString("ja-JP")}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <details className="card card-pad">
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>技術的な詳細</summary>
              <dl className="kv-list">
                <div>
                  <dt>エラーコード</dt>
                  <dd>{error.errorCode}</dd>
                </div>
                <div>
                  <dt>ジョブID</dt>
                  <dd>{error.jobId ?? "—"}</dd>
                </div>
              </dl>
              <p style={{ fontSize: "0.82rem", marginTop: "0.5rem", whiteSpace: "pre-wrap" }}>{error.errorMessage}</p>
            </details>
          </div>
        )}
      </div>
    </>
  );
}

export default function SyncErrorDetailPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <SyncErrorDetailInner />
    </Suspense>
  );
}
