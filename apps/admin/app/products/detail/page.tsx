"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface ProductMasterRow {
  id: string;
  sku: string;
  title: string;
  descriptionJa: string;
  brand: string | null;
  material: string | null;
  sizeLabel: string | null;
  priceJpy: number;
  images: string[];
  status: string;
}

interface ChannelListing {
  channel: string;
  status: string;
  externalId: string | null;
  lastSyncedAt: string | null;
}

interface AiListingDraft {
  id: string;
  titleEn: string;
  descriptionHtmlEn: string;
  categoryCandidates: Array<{ ebayCategoryId: string; label: string }>;
  itemSpecifics: Record<string, string | null>;
  condition: string;
  confidenceFlags: Record<string, "confirmed" | "uncertain" | "unknown">;
  needsHumanReview: boolean;
  reviewNotes: string[];
}

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

interface DynamicPrice {
  recommendedPriceUsd: number;
  netMarginRatio: number;
  costMarkupRatio: number;
  fxRateUsdPerJpy: number;
}

const CONFIDENCE_LABEL: Record<string, string> = { confirmed: "確認済み", uncertain: "未確認", unknown: "不明" };
const FIELD_LABEL_JA: Record<string, string> = {
  brand: "ブランド",
  material: "素材",
  size: "サイズ",
  authenticity: "真贋",
  condition: "状態",
};

function ProductDetailInner() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const id = searchParams.get("id");

  const [product, setProduct] = useState<ProductMasterRow | null>(null);
  const [listings, setListings] = useState<ChannelListing[]>([]);
  const [draft, setDraft] = useState<AiListingDraft | null>(null);
  const [inventory, setInventory] = useState<InventoryBreakdown | null>(null);
  const [dynamicPrice, setDynamicPrice] = useState<DynamicPrice | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [edits, setEdits] = useState<Record<string, string>>({});
  const [savingDraft, setSavingDraft] = useState(false);
  const [missingAspects, setMissingAspects] = useState<string[] | null>(null);
  const [checkingPreflight, setCheckingPreflight] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [detail, breakdown] = await Promise.all([
        apiGet<{ product: ProductMasterRow; listings: ChannelListing[]; draft: AiListingDraft | null }>(`/admin/products/${id}`),
        apiGet<InventoryBreakdown | null>(`/admin/products/${id}/inventory-breakdown`).catch(() => null),
      ]);
      setProduct(detail.product);
      setListings(detail.listings);
      setDraft(detail.draft);
      setInventory(breakdown);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);

  useEffect(() => {
    if (!id || !draft) return;
    apiGet<DynamicPrice>(`/admin/products/${id}/dynamic-price`)
      .then(setDynamicPrice)
      .catch(() => setDynamicPrice(null));
  }, [id, draft]);

  const mergedSpecifics = useMemo(() => ({ ...(draft?.itemSpecifics ?? {}), ...edits }), [draft, edits]);
  const editedKeys = useMemo(() => Object.keys(edits).filter((k) => edits[k] !== (draft?.itemSpecifics[k] ?? "")), [edits, draft]);
  const hasPendingEdits = editedKeys.length > 0;

  async function saveDraft() {
    if (!id || !hasPendingEdits) return;
    setSavingDraft(true);
    try {
      const payload: Record<string, string> = {};
      for (const k of editedKeys) payload[k] = edits[k];
      const res = await apiPost<{ itemSpecifics: Record<string, string | null> }>(`/admin/products/${id}/draft-item-specifics`, {
        itemSpecifics: payload,
      });
      setDraft((d) => (d ? { ...d, itemSpecifics: res.itemSpecifics } : d));
      setEdits({});
      notify("下書きを保存しました。", "success");
    } catch (err) {
      notify(`下書きの保存に失敗しました: ${(err as Error).message}`);
    } finally {
      setSavingDraft(false);
    }
  }

  async function reviewBeforeApproval() {
    if (!id) return;
    // Save any pending item-specifics edits first so the preflight check (and the eventual
    // approval) is evaluated against exactly what's about to be submitted, not a stale draft.
    if (hasPendingEdits) await saveDraft();
    setCheckingPreflight(true);
    try {
      const res = await apiGet<{ missingAspects: string[] }>(`/admin/products/${id}/preflight-check`);
      setMissingAspects(res.missingAspects);
      setConfirming(true);
    } catch (err) {
      notify(`確認に失敗しました: ${(err as Error).message}`);
    } finally {
      setCheckingPreflight(false);
    }
  }

  async function approve() {
    if (!id || approving) return; // guards against a double click firing two approvals
    setApproving(true);
    try {
      await apiPost(`/admin/products/${id}/approve-ebay-listing`);
      setApproved(true);
      notify("eBayへの出品を承認しました。", "success");
    } catch (err) {
      notify(`承認に失敗しました: ${(err as Error).message}`);
    } finally {
      setApproving(false);
    }
  }

  if (!id) {
    return (
      <>
        <Topbar />
        <div className="page">
          <EmptyStateBlock>商品IDが指定されていません。商品マスターから開き直してください。</EmptyStateBlock>
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <button type="button" className="button secondary" onClick={() => router.push("/products")}>
              ← 商品マスターへ戻る
            </button>
          </div>
        </div>

        {!ready || loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <EmptyStateBlock>
            読み込みに失敗しました: {loadError}
            <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => load()}>
              再試行
            </button>
          </EmptyStateBlock>
        ) : !product ? (
          <EmptyStateBlock>商品が見つかりませんでした。</EmptyStateBlock>
        ) : (
          <div className="detail-doc">
            {/* 1. 商品写真 */}
            <section className="card card-pad">
              {product.images[0] ? (
                <img src={product.images[0]} alt={product.title} className="detail-thumb" style={{ maxWidth: 240 }} />
              ) : (
                <div className="detail-thumb" style={{ maxWidth: 240 }} />
              )}
            </section>

            {/* 2. 元の商品情報 */}
            <section className="card card-pad">
              <div className="section-eyebrow">元の商品情報(BASE)</div>
              <h2 style={{ margin: "0.3rem 0" }}>{product.title}</h2>
              <dl className="kv-list">
                <div>
                  <dt>SKU</dt>
                  <dd>{product.sku}</dd>
                </div>
                <div>
                  <dt>価格</dt>
                  <dd>¥{product.priceJpy.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>ブランド</dt>
                  <dd>{product.brand ?? "未設定"}</dd>
                </div>
                <div>
                  <dt>素材</dt>
                  <dd>{product.material ?? "未設定"}</dd>
                </div>
                <div>
                  <dt>サイズ</dt>
                  <dd>{product.sizeLabel ?? "未設定"}</dd>
                </div>
              </dl>
              {product.descriptionJa && (
                <p style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "var(--fg-muted)", whiteSpace: "pre-wrap" }}>
                  {product.descriptionJa}
                </p>
              )}
            </section>

            {!draft ? (
              <EmptyStateBlock>この商品はまだAIによる出品ドラフトが生成されていません。</EmptyStateBlock>
            ) : (
              <>
                {/* 3. 英語タイトル・説明(AI生成) */}
                <section className="card card-pad">
                  <div className="section-eyebrow">AIが生成した内容(eBay向け・英語)</div>
                  <p style={{ fontSize: "0.78rem", color: "var(--fg-subtle)", marginTop: "0.2rem" }}>
                    タイトル・説明文は現時点では編集できません。内容に誤りがある場合は下書きのまま承認せず、BASE側の商品情報を修正してから再生成をお待ちください。
                  </p>
                  <h3 style={{ marginBottom: "0.4rem" }}>{draft.titleEn}</h3>
                  <div
                    className="ai-description-preview"
                    dangerouslySetInnerHTML={{ __html: draft.descriptionHtmlEn }}
                  />
                </section>

                {/* 4 + 5. item specifics + 未確認・不足項目 */}
                <section className="card card-pad">
                  <div className="section-eyebrow">Item Specifics(編集可能)</div>
                  <div className="specifics-grid">
                    {Object.keys(mergedSpecifics).map((key) => (
                      <label key={key} className="specifics-field">
                        <span>{key}</span>
                        <input
                          type="text"
                          value={mergedSpecifics[key] ?? ""}
                          placeholder="未入力"
                          onChange={(e) => setEdits((s) => ({ ...s, [key]: e.target.value }))}
                        />
                      </label>
                    ))}
                  </div>

                  {draft.needsHumanReview && (
                    <div className="auth-error" style={{ marginTop: "1rem" }}>
                      <strong>要確認:</strong> AIが確信を持てなかった項目があります。BASEの元情報と照らして確認してください。
                      <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                        {Object.entries(draft.confidenceFlags)
                          .filter(([, v]) => v !== "confirmed")
                          .map(([field, v]) => (
                            <li key={field}>
                              {FIELD_LABEL_JA[field] ?? field}: {CONFIDENCE_LABEL[v] ?? v}
                            </li>
                          ))}
                      </ul>
                      {draft.reviewNotes.length > 0 && (
                        <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.2rem" }}>
                          {draft.reviewNotes.map((note, i) => (
                            <li key={i}>{note}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </section>

                {/* 6. eBay価格と見込み利益 */}
                <section className="card card-pad">
                  <div className="section-eyebrow">eBay価格と見込み利益</div>
                  {dynamicPrice ? (
                    <div className="detail-metric-grid">
                      <div className="detail-metric">
                        <div className="detail-metric-value">${dynamicPrice.recommendedPriceUsd.toFixed(2)}</div>
                        <div className="detail-metric-label">AI提案価格</div>
                      </div>
                      <div className="detail-metric">
                        <div className="detail-metric-value">{(dynamicPrice.netMarginRatio * 100).toFixed(1)}%</div>
                        <div className="detail-metric-label">見込み利益率(価格に対する比率)</div>
                      </div>
                    </div>
                  ) : (
                    <p style={{ color: "var(--fg-subtle)", fontSize: "0.85rem" }}>価格計算に必要な情報が未設定です(送料・目標利益率)。</p>
                  )}
                  <p style={{ fontSize: "0.76rem", color: "var(--fg-subtle)" }}>
                    為替レート・eBay手数料・送料をもとに算出した見込み値です。確定した利益ではありません。
                  </p>
                </section>

                {/* 7. 在庫と出品先 */}
                <section className="card card-pad">
                  <div className="section-eyebrow">在庫と出品先</div>
                  {inventory && (
                    <p style={{ fontSize: "0.88rem" }}>
                      手持在庫 {inventory.onHand}点 ・ 引当 {inventory.reserved}点 ・{" "}
                      {Object.entries(inventory.sellableByChannel)
                        .map(([ch, qty]) => `${ch.toUpperCase()}販売可 ${qty}点`)
                        .join(" / ")}
                    </p>
                  )}
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
                    {listings.map((l) => (
                      <span key={l.channel} className="badge">
                        {l.channel.toUpperCase()}: {l.status}
                      </span>
                    ))}
                  </div>
                </section>

                {/* 8. 保存・確認・承認操作 */}
                {product.status !== "ai_generated" ? (
                  <section className="card card-pad">
                    <p style={{ margin: 0 }}>
                      この商品は現在「{product.status}」の状態のため、この画面からの承認操作はできません。
                    </p>
                  </section>
                ) : approved ? (
                  <section className="card card-pad">
                    <p style={{ margin: 0, color: "var(--success)" }}>✓ 承認済み — eBayへの出品をキューに登録しました。</p>
                  </section>
                ) : confirming ? (
                  <section className="card card-pad">
                    <div className="section-eyebrow">最終確認</div>
                    <dl className="kv-list">
                      <div>
                        <dt>出品先</dt>
                        <dd>eBay</dd>
                      </div>
                      <div>
                        <dt>価格</dt>
                        <dd>{dynamicPrice ? `$${dynamicPrice.recommendedPriceUsd.toFixed(2)}` : "—"}</dd>
                      </div>
                      <div>
                        <dt>数量</dt>
                        <dd>{inventory ? `${inventory.available}点` : "—"}</dd>
                      </div>
                      <div>
                        <dt>変更点</dt>
                        <dd>{editedKeys.length > 0 ? `item specifics ${editedKeys.length}件を変更` : "変更なし"}</dd>
                      </div>
                    </dl>
                    {missingAspects && missingAspects.length > 0 ? (
                      <div className="auth-error">
                        以下の必須項目が未入力のため承認できません: {missingAspects.join("、")}
                      </div>
                    ) : (
                      <div className="page-actions">
                        <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={approving}>
                          修正に戻る
                        </button>
                        <button type="button" onClick={approve} disabled={approving}>
                          {approving ? "処理中..." : "承認する"}
                        </button>
                      </div>
                    )}
                  </section>
                ) : (
                  <div className="page-actions">
                    <button type="button" className="secondary" onClick={saveDraft} disabled={!hasPendingEdits || savingDraft}>
                      {savingDraft ? "保存中..." : "下書き保存"}
                    </button>
                    <button type="button" onClick={reviewBeforeApproval} disabled={checkingPreflight}>
                      {checkingPreflight ? "確認中..." : "内容を確認"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function EmptyStateBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="table-wrapper" style={{ padding: "2rem", textAlign: "center", color: "var(--fg-subtle)" }}>
      {children}
    </div>
  );
}

export default function ProductDetailPage() {
  return (
    <Suspense fallback={<SkeletonRows />}>
      <ProductDetailInner />
    </Suspense>
  );
}
