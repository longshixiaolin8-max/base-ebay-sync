"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { KpiCard } from "@/components/ui/KpiCard";
import { Select } from "@/components/ui/Select";
import { AlertIcon, CheckIcon, FileIcon, SyncIcon } from "@/components/icons";
import { DraftListPanel } from "@/components/drafts/DraftListPanel";
import { DraftEditorPanel } from "@/components/drafts/DraftEditorPanel";
import { DraftComparisonPanel } from "@/components/drafts/DraftComparisonPanel";
import { DraftHistoryPanel } from "@/components/drafts/DraftHistoryPanel";
import { SeoKeywordsEditor } from "@/components/drafts/SeoKeywordsEditor";
import type {
  AiListingDraftRow,
  ChannelListingRow,
  DraftListItem,
  DraftsKpi,
  DynamicPrice,
  InventoryBreakdown,
  PreflightCheck,
  ProductDetailRow,
} from "@/components/drafts/types";

interface DraftDetail {
  product: ProductDetailRow;
  listings: ChannelListingRow[];
  draft: AiListingDraftRow;
}

export default function DraftsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();

  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [kpi, setKpi] = useState<DraftsKpi | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState<"created_desc" | "created_asc">("created_desc");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");

  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DraftDetail | null>(null);
  const [inventory, setInventory] = useState<InventoryBreakdown | null>(null);
  const [dynamicPrice, setDynamicPrice] = useState<DynamicPrice | null>(null);
  const [preflight, setPreflight] = useState<PreflightCheck | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [auditLog, setAuditLog] = useState<AuditLogEntry[]>([]);

  const [itemSpecifics, setItemSpecifics] = useState<Record<string, string | null>>({});
  const [condition, setCondition] = useState("");
  const [priceInput, setPriceInput] = useState("");
  const [seoKeywords, setSeoKeywords] = useState<string[]>([]);
  const [internalNotes, setInternalNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);

  const loadDrafts = useCallback(async () => {
    setListLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      params.set("sort", sort);
      if (from) params.set("from", new Date(from).toISOString());
      if (to) params.set("to", new Date(to).toISOString());
      if (query.trim()) params.set("q", query.trim());
      const res = await apiGet<{ drafts: DraftListItem[]; kpi: DraftsKpi }>(`/admin/drafts?${params.toString()}`);
      setDrafts(res.drafts);
      setKpi(res.kpi);
      setSelectedProductId((current) => {
        if (current && res.drafts.some((d) => d.productId === current)) return current;
        return res.drafts[0]?.productId ?? null;
      });
    } catch (err) {
      notify(`下書き一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setListLoading(false);
    }
  }, [statusFilter, sort, from, to, query, notify]);

  useEffect(() => {
    if (ready) void loadDrafts();
  }, [ready, loadDrafts]);

  useEffect(() => {
    if (ready) {
      apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log")
        .then((res) => setAuditLog(res.auditLog))
        .catch(() => {});
    }
  }, [ready]);

  const loadDetail = useCallback(
    async (productId: string) => {
      setDetailLoading(true);
      try {
        const [d, inv, price, pre] = await Promise.all([
          apiGet<{ product: ProductDetailRow; listings: ChannelListingRow[]; draft: AiListingDraftRow | null }>(
            `/admin/products/${productId}`,
          ),
          apiGet<InventoryBreakdown | null>(`/admin/products/${productId}/inventory-breakdown`).catch(() => null),
          apiGet<DynamicPrice>(`/admin/products/${productId}/dynamic-price`).catch(() => null),
          apiGet<PreflightCheck>(`/admin/products/${productId}/preflight-check`).catch(() => null),
        ]);
        if (!d.draft) {
          setDetail(null);
          return;
        }
        setDetail({ product: d.product, listings: d.listings, draft: d.draft });
        setItemSpecifics(d.draft.itemSpecifics);
        setCondition(d.draft.condition);
        setPriceInput(d.draft.suggestedPriceUsd != null ? (d.draft.suggestedPriceUsd / 100).toFixed(2) : "");
        setSeoKeywords(d.draft.seoKeywords);
        setInternalNotes(d.draft.internalNotes ?? "");
        setInventory(inv);
        setDynamicPrice(price);
        setPreflight(pre);
      } catch (err) {
        notify(`下書きの取得に失敗しました: ${(err as Error).message}`);
      } finally {
        setDetailLoading(false);
      }
    },
    [notify],
  );

  useEffect(() => {
    if (!selectedProductId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedProductId);
  }, [selectedProductId, loadDetail]);

  const dirty = useMemo(() => {
    if (!detail) return false;
    const specDirty = JSON.stringify(itemSpecifics) !== JSON.stringify(detail.draft.itemSpecifics);
    const conditionDirty = condition !== detail.draft.condition;
    const priceDirty = priceInput !== (detail.draft.suggestedPriceUsd != null ? (detail.draft.suggestedPriceUsd / 100).toFixed(2) : "");
    const seoDirty = JSON.stringify(seoKeywords) !== JSON.stringify(detail.draft.seoKeywords);
    const notesDirty = internalNotes !== (detail.draft.internalNotes ?? "");
    return specDirty || conditionDirty || priceDirty || seoDirty || notesDirty;
  }, [detail, itemSpecifics, condition, priceInput, seoKeywords, internalNotes]);

  async function handleSave() {
    if (!detail || !selectedProductId) return;
    setSaving(true);
    try {
      const calls: Promise<unknown>[] = [];
      if (JSON.stringify(itemSpecifics) !== JSON.stringify(detail.draft.itemSpecifics)) {
        calls.push(apiPost(`/admin/products/${selectedProductId}/draft-item-specifics`, { itemSpecifics }));
      }
      if (condition !== detail.draft.condition) {
        calls.push(apiPost(`/admin/products/${selectedProductId}/draft-condition`, { condition }));
      }
      const currentPriceStr = detail.draft.suggestedPriceUsd != null ? (detail.draft.suggestedPriceUsd / 100).toFixed(2) : "";
      if (priceInput !== currentPriceStr && priceInput.trim() !== "") {
        calls.push(apiPost(`/admin/products/${selectedProductId}/draft-price`, { suggestedPriceUsd: Number(priceInput) }));
      }
      if (JSON.stringify(seoKeywords) !== JSON.stringify(detail.draft.seoKeywords)) {
        calls.push(apiPost(`/admin/products/${selectedProductId}/draft-seo-keywords`, { seoKeywords }));
      }
      if (internalNotes !== (detail.draft.internalNotes ?? "")) {
        calls.push(apiPost(`/admin/products/${selectedProductId}/draft-notes`, { internalNotes: internalNotes || null }));
      }
      await Promise.all(calls);
      notify("保存しました。");
      void loadDetail(selectedProductId);
      void loadDrafts();
    } catch (err) {
      notify(`保存に失敗しました: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    if (!selectedProductId) return;
    setApproving(true);
    try {
      await apiPost(`/admin/products/${selectedProductId}/approve-ebay-listing`, {});
      notify("eBayへの出品を承認しました。");
      setSelectedProductId(null);
      void loadDrafts();
    } catch (err) {
      notify(`承認に失敗しました: ${(err as Error).message}`);
    } finally {
      setApproving(false);
    }
  }

  const ebayListing = detail?.listings.find((l) => l.channel === "ebay");

  return (
    <>
      <Topbar searchPlaceholder="商品・注文・SKUなどを検索..." />
      <div className="page page-wide">
        <PageHeader
          title="AI出品下書き"
          lead="AIが生成したeBayの出品内容を確認・編集し、承認して公開できます。"
          actions={
            <div className="draft-date-range">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="開始日" />
              <span>〜</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="終了日" />
            </div>
          }
        />

        {!ready || (listLoading && !kpi) ? (
          <SkeletonRows count={4} />
        ) : (
          kpi && (
            <>
              <div className="kpi-grid">
                <KpiCard icon={FileIcon} color="blue" value={kpi.reviewPending} label="レビュー待ち" />
                <KpiCard icon={AlertIcon} color={kpi.needsFix > 0 ? "red" : "green"} value={kpi.needsFix} label="要修正" />
                <KpiCard icon={CheckIcon} color="green" value={kpi.publishedToday} label="今日公開" />
                <KpiCard icon={SyncIcon} color="purple" value={`${kpi.avgConfidence}%`} label="平均信頼度" />
              </div>

              <div className="drafts-layout">
                <Card className="drafts-list-card">
                  <div className="drafts-list-filters">
                    <input type="text" placeholder="検索..." value={query} onChange={(e) => setQuery(e.target.value)} />
                    <Select label="ステータス" value={statusFilter} onChange={setStatusFilter}>
                      <option value="">すべてのステータス</option>
                      <option value="needs_review">要確認のみ</option>
                    </Select>
                    <Select label="並び替え" value={sort} onChange={(v) => setSort(v as "created_desc" | "created_asc")}>
                      <option value="created_desc">作成日(新しい順)</option>
                      <option value="created_asc">作成日(古い順)</option>
                    </Select>
                  </div>
                  <div className="drafts-list-count">下書き一覧({drafts.length}件)</div>
                  <DraftListPanel drafts={drafts} selectedProductId={selectedProductId} onSelect={setSelectedProductId} />
                </Card>

                <div className="drafts-main-col">
                  {detailLoading || !detail ? (
                    <Card>
                      {detailLoading ? <SkeletonRows count={3} /> : <EmptyState>下書きを選択してください。</EmptyState>}
                    </Card>
                  ) : (
                    <DraftEditorPanel
                      product={detail.product}
                      draft={detail.draft}
                      preflight={preflight}
                      itemSpecifics={itemSpecifics}
                      onItemSpecificChange={(key, value) => setItemSpecifics((s) => ({ ...s, [key]: value }))}
                      condition={condition}
                      onConditionChange={setCondition}
                      priceInput={priceInput}
                      onPriceChange={setPriceInput}
                      dynamicPrice={dynamicPrice}
                      onSave={handleSave}
                      onApprove={handleApprove}
                      saving={saving}
                      approving={approving}
                      dirty={dirty}
                    />
                  )}
                </div>

                <div className="drafts-side-col">
                  {detail && (
                    <>
                      <Card>
                        <div className="section-eyebrow">比較</div>
                        <DraftComparisonPanel product={detail.product} draft={detail.draft} ebayListing={ebayListing} />
                      </Card>
                      <Card>
                        <div className="section-eyebrow">履歴</div>
                        <DraftHistoryPanel entries={auditLog} productId={detail.product.id} draftId={detail.draft.id} />
                      </Card>
                      <Card>
                        <div className="section-eyebrow">SEOキーワード(推奨)</div>
                        <SeoKeywordsEditor keywords={seoKeywords} onChange={setSeoKeywords} />
                      </Card>
                      <Card>
                        <div className="section-eyebrow">作業メモ(社内向け)</div>
                        <textarea
                          className="draft-notes-textarea"
                          value={internalNotes}
                          onChange={(e) => setInternalNotes(e.target.value)}
                          placeholder="社内向けのメモを入力..."
                          rows={4}
                        />
                      </Card>
                    </>
                  )}
                  {inventory && (
                    <Card>
                      <div className="section-eyebrow">在庫</div>
                      <p style={{ fontSize: "0.85rem" }}>
                        手持在庫 {inventory.onHand}点 ・ 販売可能 {inventory.available}点
                      </p>
                    </Card>
                  )}
                </div>
              </div>
            </>
          )
        )}
      </div>
    </>
  );
}
