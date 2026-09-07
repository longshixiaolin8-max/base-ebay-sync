"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface BillingStatus {
  plan: string;
  status: "pending_payment" | "active" | "past_due" | "canceled";
}

interface UsageStatus {
  products: { used: number; limit: number };
  aiGenerations: { used: number; limit: number; periodStart: string };
}

const STATUS_LABEL: Record<BillingStatus["status"], string> = {
  pending_payment: "決済待ち",
  active: "有効",
  past_due: "支払い失敗",
  canceled: "解約済み",
};

const STATUS_MESSAGE: Record<BillingStatus["status"], string | null> = {
  pending_payment: "決済が完了していません。Stripeの決済画面で登録を完了してください。",
  active: null,
  past_due: "お支払いに失敗しました。下のボタンからお支払い方法を更新してください。",
  canceled: "サブスクリプションが解約されています。継続するには再度お手続きください。",
};

export default function BillingPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);

  useEffect(() => {
    if (!ready) return;
    apiGet<BillingStatus>("/admin/billing/status")
      .then(setBilling)
      .catch((err) => notify(`請求情報の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
    // /admin/usage sits behind the normal billing-active gate (see admin-api's Phase 3
    // quota routes) -- an inactive tenant simply won't get usage numbers, which is fine
    // since this section is purely informational and the status card above already
    // explains why access is blocked.
    apiGet<UsageStatus>("/admin/usage")
      .then(setUsage)
      .catch(() => undefined);
  }, [ready]);

  async function openPortal() {
    setOpeningPortal(true);
    try {
      const { url } = await apiPost<{ url: string }>("/admin/billing/portal-session");
      window.location.href = url;
    } catch (err) {
      notify(`Stripeポータルを開けませんでした: ${(err as Error).message}`);
      setOpeningPortal(false);
    }
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>請求</h1>
            <p className="page-lead">プランと支払い状況の確認、Stripeでのお支払い方法の管理ができます。</p>
          </div>
        </div>

        {!ready || loading ? (
          <div className="card card-pad">読み込み中...</div>
        ) : billing ? (
          <div className="card card-pad" style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--fg-muted)" }}>プラン</span>
              <strong>{billing.plan === "standard" ? "スタンダードプラン" : billing.plan}</strong>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: "0.5rem" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--fg-muted)" }}>状態</span>
              <span className={`badge ${billing.status === "active" ? "ok" : "warn"}`}>{STATUS_LABEL[billing.status]}</span>
            </div>
            {STATUS_MESSAGE[billing.status] && (
              <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>{STATUS_MESSAGE[billing.status]}</p>
            )}
            <button type="button" onClick={openPortal} disabled={openingPortal} style={{ marginTop: "1.25rem", width: "100%" }}>
              {openingPortal ? "開いています..." : "Stripeでお支払い方法を管理"}
            </button>
          </div>
        ) : null}

        {usage && (
          <div className="card card-pad" style={{ maxWidth: 480, marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "0.95rem", margin: 0 }}>利用状況</h2>
            <UsageRow label="商品登録数" used={usage.products.used} limit={usage.products.limit} />
            <UsageRow label="AI生成(今月)" used={usage.aiGenerations.used} limit={usage.aiGenerations.limit} />
          </div>
        )}
      </div>
    </>
  );
}

function UsageRow({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  const nearLimit = ratio >= 0.9;
  return (
    <div style={{ marginTop: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85rem" }}>
        <span style={{ color: "var(--fg-muted)" }}>{label}</span>
        <span className={nearLimit ? "badge warn" : undefined}>
          {used} / {limit}
        </span>
      </div>
      <div style={{ marginTop: "0.35rem", height: 6, borderRadius: 3, background: "var(--neutral-soft)", overflow: "hidden" }}>
        <div
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            background: nearLimit ? "var(--danger)" : "var(--accent)",
          }}
        />
      </div>
    </div>
  );
}
