"use client";

import type { ProductMaster } from "@ai-ec/core";
import { fetchAuthSession } from "aws-amplify/auth";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { LinkIcon } from "@/components/icons";

interface UnmanagedListing {
  externalId: string;
  title: string;
  descriptionHtml: string;
  images: string[];
  suggestedProductId: string | null;
  matchScore?: number;
  matchReasons?: string[];
}

type Decision = { action: "link"; productId: string } | { action: "skip" };

function storageKey(tenantId: string): string {
  return `link-existing-decisions:${tenantId}`;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 導入前からeBayに出品されていた商品(このプラットフォームがまだ知らない出品)を、
 * BASE側の商品と紐付ける画面。紐付けずに承認・出品を進めると、同じ商品が
 * product-fetch/ai-generate-worker経由で新規に重複出品されうる -- その事故を防ぐための
 * 唯一の導線。バックエンドの候補判定(GET /admin/ebay/unmanaged-listings)は既存実装を
 * そのまま使い、この画面は確認・実行のUIを提供するのみ。
 *
 * 決定は1件ずつレビューし、ローカルにのみ保持(タブごとの一時状態+ localStorageへの保存)
 * して、最後にまとめて確認してから実際のAPI呼び出しを行う。eBay側の価格はこのAPIのデータ
 * ソース(Inventory Item)には含まれないため表示しない(在庫アイテムAPIは価格を持たず、
 * 実際の価格は別のOffer APIにあるため、ここで数値を出すと必ず偽の$0になってしまう)。
 */
export default function LinkExistingListingsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [listings, setListings] = useState<UnmanagedListing[] | null>(null);
  const [products, setProducts] = useState<ProductMaster[]>([]);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"review" | "summary" | "done">("review");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [applying, setApplying] = useState(false);
  const [tenantId, setTenantId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadFailed(false);
    try {
      ensureAmplifyConfigured();
      const session = await fetchAuthSession();
      const tid = (session.tokens?.idToken?.payload?.["custom:tenant_id"] as string | undefined) ?? null;
      setTenantId(tid);

      const [listingsRes, productsRes] = await Promise.all([
        apiGet<{ unmanagedListings: UnmanagedListing[] }>("/admin/ebay/unmanaged-listings"),
        apiGet<{ products: ProductMaster[] }>("/admin/products"),
      ]);
      setListings(listingsRes.unmanagedListings);
      setProducts(productsRes.products);

      const initial: Record<string, Decision> = {};
      for (const l of listingsRes.unmanagedListings) {
        if (l.suggestedProductId) initial[l.externalId] = { action: "link", productId: l.suggestedProductId };
      }

      if (tid) {
        try {
          const saved = localStorage.getItem(storageKey(tid));
          if (saved) {
            const parsed = JSON.parse(saved) as Record<string, Decision>;
            // Only keep decisions for listings that are still actually unmanaged -- stale
            // entries (already linked since, or left over from a different eBay account
            // state) are silently dropped rather than replayed against different data.
            const stillUnmanaged = new Set(listingsRes.unmanagedListings.map((l) => l.externalId));
            for (const [externalId, decision] of Object.entries(parsed)) {
              if (stillUnmanaged.has(externalId)) initial[externalId] = decision;
            }
          }
        } catch {
          // localStorage can throw in some private-browsing modes -- resuming later is a
          // convenience, not a guarantee, so just start fresh in that case.
        }
      }
      setDecisions(initial);
      setIndex(0);
      setPhase("review");
    } catch (err) {
      setLoadFailed(true);
      notify(`既存出品の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  function persist(next: Record<string, Decision>) {
    setDecisions(next);
    if (!tenantId) return;
    try {
      localStorage.setItem(storageKey(tenantId), JSON.stringify(next));
    } catch {
      // best-effort only -- resuming later is a convenience, not a guarantee
    }
  }

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const current = listings?.[index] ?? null;
  const currentDecision = current ? decisions[current.externalId] : undefined;
  const suggestedProduct = current?.suggestedProductId ? (productById.get(current.suggestedProductId) ?? null) : null;
  const manualProductId = currentDecision?.action === "link" && currentDecision.productId !== current?.suggestedProductId ? currentDecision.productId : "";

  function chooseSuggested() {
    if (!current || !current.suggestedProductId) return;
    persist({ ...decisions, [current.externalId]: { action: "link", productId: current.suggestedProductId } });
  }

  function chooseManual(productId: string) {
    if (!current || !productId) return;
    persist({ ...decisions, [current.externalId]: { action: "link", productId } });
  }

  function chooseSkip() {
    if (!current) return;
    persist({ ...decisions, [current.externalId]: { action: "skip" } });
  }

  function goNext() {
    if (!listings) return;
    if (index + 1 >= listings.length) {
      setPhase("summary");
    } else {
      setIndex(index + 1);
    }
  }

  function goBack() {
    if (phase === "summary") {
      setPhase("review");
      return;
    }
    if (index === 0) return;
    setIndex(index - 1);
  }

  function saveForLater() {
    notify("進行状況を保存しました。後でこのページに戻ると続きから再開できます。", "success");
  }

  async function confirmAll() {
    if (!listings) return;
    setApplying(true);
    let succeeded = 0;
    let failed = 0;
    try {
      for (const listing of listings) {
        const decision = decisions[listing.externalId];
        if (!decision || decision.action !== "link") continue;
        try {
          await apiPost(`/admin/products/${decision.productId}/link-ebay-listing`, { externalId: listing.externalId });
          succeeded++;
        } catch (err) {
          failed++;
          notify(`「${listing.title}」の紐付けに失敗しました: ${(err as Error).message}`);
        }
      }
      if (succeeded > 0) notify(`${succeeded}件を紐付けました。`, "success");

      const refreshed = await apiGet<{ unmanagedListings: UnmanagedListing[] }>("/admin/ebay/unmanaged-listings");
      setListings(refreshed.unmanagedListings);
      const stillUnmanaged = new Set(refreshed.unmanagedListings.map((l) => l.externalId));
      const remainingDecisions: Record<string, Decision> = {};
      for (const [externalId, decision] of Object.entries(decisions)) {
        if (stillUnmanaged.has(externalId)) remainingDecisions[externalId] = decision;
      }
      setDecisions(remainingDecisions);
      if (tenantId) {
        try {
          if (Object.keys(remainingDecisions).length > 0) {
            localStorage.setItem(storageKey(tenantId), JSON.stringify(remainingDecisions));
          } else {
            localStorage.removeItem(storageKey(tenantId));
          }
        } catch {
          // best-effort
        }
      }

      if (refreshed.unmanagedListings.length === 0) {
        setPhase("done");
      } else if (failed > 0) {
        setIndex(0);
        setPhase("review");
      } else {
        setPhase("done");
      }
    } finally {
      setApplying(false);
    }
  }

  const decidedCount = listings ? listings.filter((l) => decisions[l.externalId]).length : 0;

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>商品を紐付ける</h1>
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
        ) : loadFailed ? (
          <div className="table-wrapper">
            <EmptyState>
              読み込みに失敗しました。
              <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => load()}>
                再試行
              </button>
            </EmptyState>
          </div>
        ) : !listings || listings.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>紐付けが必要な出品は見つかりませんでした。eBayの出品はすべてこのプラットフォームで管理済みです。</EmptyState>
          </div>
        ) : phase === "done" ? (
          <div className="card card-pad" style={{ textAlign: "center", padding: "2.5rem 1.5rem" }}>
            <p style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0 }}>紐付けが完了しました</p>
            <p style={{ color: "var(--fg-subtle)", marginTop: "0.5rem" }}>
              紐付けが必要な出品は残っていません。商品マスターから確認できます。
            </p>
            <Link href="/products" className="button" style={{ marginTop: "1.25rem", display: "inline-block" }}>
              商品マスターへ戻る
            </Link>
          </div>
        ) : phase === "summary" ? (
          <div className="detail-doc">
            <div className="card card-pad">
              <div className="section-eyebrow">確認({decidedCount}/{listings.length}件に決定済み)</div>
              <ul style={{ margin: "0.75rem 0 0", padding: 0, listStyle: "none" }}>
                {listings.map((l) => {
                  const d = decisions[l.externalId];
                  const linkedProduct = d?.action === "link" ? productById.get(d.productId) : null;
                  return (
                    <li
                      key={l.externalId}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "0.75rem",
                        padding: "0.6rem 0",
                        borderBottom: "1px solid var(--border)",
                        fontSize: "0.88rem",
                      }}
                    >
                      <span>{l.title}</span>
                      {!d ? (
                        <span style={{ color: "var(--warn)" }}>未決定</span>
                      ) : d.action === "skip" ? (
                        <span style={{ color: "var(--fg-subtle)" }}>スキップ</span>
                      ) : (
                        <span style={{ color: "var(--accent)" }}>→ {linkedProduct ? `${linkedProduct.title} (${linkedProduct.sku})` : "選択した商品"}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="auth-callout warn" style={{ marginTop: 0 }}>
              <span>確認してから確定します。「確定する」を押すと、紐付けを選んだ項目についてまとめて反映されます。</span>
            </div>

            <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
              <button type="button" className="secondary" onClick={goBack} disabled={applying}>
                ← 戻って修正する
              </button>
              <button type="button" onClick={confirmAll} disabled={applying}>
                {applying ? "反映中..." : "確定する"}
              </button>
            </div>
          </div>
        ) : current ? (
          <div className="detail-doc">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <p style={{ margin: 0, color: "var(--fg-subtle)", fontSize: "0.85rem" }}>同じ商品か確認してください。</p>
              <span className="match-progress">
                商品 {index + 1} / {listings.length}
              </span>
            </div>

            <div className="card">
              <div className="match-card">
                {suggestedProduct?.images?.[0] ? (
                  <img src={suggestedProduct.images[0]} alt="" className="match-card-thumb" />
                ) : (
                  <div className="match-card-thumb" />
                )}
                <div style={{ flex: 1 }}>
                  <span className="badge ok">BASE</span>
                  <div className="match-card-title">{suggestedProduct?.title ?? "(候補なし)"}</div>
                  {suggestedProduct && <p className="match-card-desc">{stripHtml(suggestedProduct.descriptionJa).slice(0, 80)}</p>}
                  {suggestedProduct && (
                    <div className="match-card-meta">
                      <span>SKU {suggestedProduct.sku}</span>
                      <span className="match-card-price">¥{suggestedProduct.priceJpy.toLocaleString()}</span>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="match-connector">
              <span className="match-connector-icon">
                <LinkIcon />
              </span>
              {current.suggestedProductId ? (
                <span className="badge ok">候補あり{typeof current.matchScore === "number" ? `(一致度 ${Math.round(current.matchScore * 100)}%)` : ""}</span>
              ) : (
                <span className="badge">候補なし</span>
              )}
            </div>

            <div className="card">
              <div className="match-card">
                {current.images[0] ? <img src={current.images[0]} alt="" className="match-card-thumb" /> : <div className="match-card-thumb" />}
                <div style={{ flex: 1 }}>
                  <span className="badge">eBay</span>
                  <div className="match-card-title">{current.title}</div>
                  <p className="match-card-desc">{stripHtml(current.descriptionHtml).slice(0, 80)}</p>
                  <div className="match-card-meta">
                    <span>{current.externalId}</span>
                  </div>
                </div>
              </div>
            </div>

            {current.matchReasons && current.matchReasons.length > 0 && (
              <p style={{ fontSize: "0.78rem", color: "var(--fg-subtle)", margin: 0 }}>判定理由: {current.matchReasons.join("・")}</p>
            )}

            <div className="card card-pad">
              <div className="section-eyebrow">この商品をどうしますか?</div>
              <div className="match-decision" style={{ marginTop: "0.6rem" }}>
                {current.suggestedProductId && (
                  <label className="match-decision-option">
                    <input
                      type="radio"
                      name={`decision-${current.externalId}`}
                      checked={currentDecision?.action === "link" && currentDecision.productId === current.suggestedProductId}
                      onChange={chooseSuggested}
                    />
                    この商品で紐付ける
                  </label>
                )}
                <label className="match-decision-option">
                  <input
                    type="radio"
                    name={`decision-${current.externalId}`}
                    checked={!!manualProductId}
                    onChange={() => {
                      if (!manualProductId && products[0]) chooseManual(products[0].id);
                    }}
                  />
                  別の商品を選ぶ
                  <select value={manualProductId} onChange={(e) => chooseManual(e.target.value)}>
                    <option value="">選択してください</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({p.sku})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="match-decision-option">
                  <input
                    type="radio"
                    name={`decision-${current.externalId}`}
                    checked={currentDecision?.action === "skip"}
                    onChange={chooseSkip}
                  />
                  紐付けずにスキップ
                </label>
              </div>
            </div>

            <div className="auth-callout warn" style={{ marginTop: 0 }}>
              <span>確認してから確定します。この後、まとめて内容を確認してから反映されます。</span>
            </div>

            <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
              <button type="button" className="secondary" onClick={goBack} disabled={index === 0}>
                ← 戻る
              </button>
              <button type="button" onClick={goNext} disabled={!currentDecision}>
                確定して次へ
              </button>
            </div>
            <div style={{ textAlign: "center" }}>
              <button type="button" onClick={saveForLater} style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.85rem", cursor: "pointer" }}>
                保存して後で続ける
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
