"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";

interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

interface SnsStatus {
  videoCreated: boolean;
  instagramPosted: boolean;
  tiktokPosted: boolean;
  scriptText: string | null;
}

interface CommerceRow {
  productId: string;
  sku: string;
  title: string;
  status: string;
  channelStatus: Record<string, string>;
  inventory: InventoryBreakdown | null;
  revenueUsdCents: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints: number | null;
  daysListed: number;
  daysToFirstSale: number | null;
  staleLevel: "fresh" | "stale_30" | "stale_60" | "stale_90";
  latestOrderStatus: string | null;
  hasReturn: boolean;
  snsStatus: SnsStatus | null;
}

const STALE_BADGE: Record<CommerceRow["staleLevel"], string> = {
  fresh: "badge ok",
  stale_30: "badge warn",
  stale_60: "badge warn",
  stale_90: "badge error",
};

const STALE_LABEL: Record<CommerceRow["staleLevel"], string> = {
  fresh: "新鮮",
  stale_30: "30日超",
  stale_60: "60日超",
  stale_90: "90日超",
};

const CHANNEL_STATUS_BADGE: Record<string, string> = {
  published: "badge ok",
  pending: "badge",
  pending_approval: "badge warn",
  update_pending: "badge warn",
  error: "badge error",
  delisted: "badge",
};

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pct(basisPoints: number | null): string {
  return basisPoints === null ? "—" : `${(basisPoints / 100).toFixed(1)}%`;
}

export default function CommercePage() {
  const { ready } = useRequireAuth();
  const [rows, setRows] = useState<CommerceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    const res = await apiGet<{ products: CommerceRow[] }>("/admin/commerce-dashboard");
    setRows(res.products);
    setLoading(false);
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function generateSuggestion(productId: string) {
    setBusyId(productId);
    try {
      const res = await apiPost<{ suggestion: string; suggestedActions: string[] }>(
        `/admin/products/${productId}/stale-suggestion`,
      );
      setSuggestions((prev) => ({
        ...prev,
        [productId]: [res.suggestion, ...res.suggestedActions.map((a) => `・${a}`)].join("\n"),
      }));
    } catch (err) {
      alert(`AI提案の生成に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function generateSnsScript(productId: string) {
    setBusyId(productId);
    try {
      await apiPost(`/admin/products/${productId}/sns/script`);
      await load();
    } catch (err) {
      alert(`SNS台本の生成に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!ready || loading) return <p>読み込み中...</p>;

  return (
    <div>
      <h1>コマース統合ビュー</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        商品・BASE/eBay状態・在庫・売上・利益・滞留状況・注文/返品状態・AI提案・SNS状況を一画面で確認できます。
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ minWidth: 1400 }}>
          <thead>
            <tr>
              <th>商品</th>
              <th>BASE/eBay状態</th>
              <th>在庫(手持/引当/販売可)</th>
              <th>売上</th>
              <th>純利益</th>
              <th>利益率</th>
              <th>出品日数</th>
              <th>販売までの日数</th>
              <th>滞留状態</th>
              <th>注文状態</th>
              <th>返品状態</th>
              <th>AI提案</th>
              <th>SNS状況</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.productId}>
                <td>
                  <div style={{ fontWeight: 600 }}>{row.title}</div>
                  <div style={{ color: "#666", fontSize: "0.8rem" }}>{row.sku}</div>
                </td>
                <td>
                  {(["base", "ebay"] as const).map((channel) => (
                    <div key={channel} style={{ marginBottom: 2 }}>
                      {channel.toUpperCase()}:{" "}
                      <span className={CHANNEL_STATUS_BADGE[row.channelStatus[channel] ?? ""] ?? "badge"}>
                        {row.channelStatus[channel] ?? "未登録"}
                      </span>
                    </div>
                  ))}
                </td>
                <td>
                  {row.inventory ? (
                    <>
                      <div>{row.inventory.onHand} / {row.inventory.reserved} / {Object.entries(row.inventory.sellableByChannel).map(([c, q]) => `${c}:${q}`).join(", ")}</div>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{usd(row.revenueUsdCents)}</td>
                <td style={{ color: row.netProfitUsdCents < 0 ? "var(--danger)" : undefined }}>{usd(row.netProfitUsdCents)}</td>
                <td>{pct(row.profitMarginBasisPoints)}</td>
                <td>{row.daysListed}日</td>
                <td>{row.daysToFirstSale === null ? "未販売" : `${row.daysToFirstSale}日`}</td>
                <td>
                  <span className={STALE_BADGE[row.staleLevel]}>{STALE_LABEL[row.staleLevel]}</span>
                </td>
                <td>{row.latestOrderStatus ?? "—"}</td>
                <td>{row.hasReturn ? <span className="badge error">返品あり</span> : "—"}</td>
                <td>
                  {row.staleLevel !== "fresh" && (
                    <button onClick={() => generateSuggestion(row.productId)} disabled={busyId === row.productId} className="secondary">
                      {busyId === row.productId ? "生成中..." : "AI提案を生成"}
                    </button>
                  )}
                  {suggestions[row.productId] && (
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem", marginTop: 4 }}>{suggestions[row.productId]}</pre>
                  )}
                </td>
                <td>
                  {row.snsStatus ? (
                    <div style={{ fontSize: "0.8rem" }}>
                      <div>動画: {row.snsStatus.videoCreated ? "✓" : "—"}</div>
                      <div>IG: {row.snsStatus.instagramPosted ? "✓" : "—"}</div>
                      <div>TikTok: {row.snsStatus.tiktokPosted ? "✓" : "—"}</div>
                    </div>
                  ) : (
                    <button onClick={() => generateSnsScript(row.productId)} disabled={busyId === row.productId} className="secondary">
                      {busyId === row.productId ? "生成中..." : "台本を生成"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
