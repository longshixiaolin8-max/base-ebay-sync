"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface BillingStatus {
  plan: string;
  status: "pending_payment" | "active" | "past_due" | "canceled";
  testMode: boolean;
}

interface UsageStatus {
  products: { used: number; limit: number };
  aiGenerations: { used: number; limit: number; periodStart: string };
}

interface PaymentMethod {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
}

interface Invoice {
  id: string;
  amountUsdCents: number;
  createdAt: string;
  status: string | null;
  hostedInvoiceUrl: string | null;
}

interface BillingDetails {
  paymentMethod: PaymentMethod | null;
  invoices: Invoice[];
  subscription: {
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    priceAmount: number | null;
    priceCurrency: string | null;
    priceInterval: string | null;
  } | null;
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

function formatPrice(amount: number, currency: string, interval: string | null): string {
  const major = amount / 100;
  const formatted = new Intl.NumberFormat("ja-JP", { style: "currency", currency: currency.toUpperCase() }).format(major);
  return interval ? `${formatted} / ${interval === "month" ? "月" : interval === "year" ? "年" : interval}` : formatted;
}

export default function BillingPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [details, setDetails] = useState<BillingDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    if (!ready) return;
    apiGet<BillingStatus>("/admin/billing/status")
      .then(setBilling)
      .catch((err) => notify(`請求情報の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
    // /admin/usage and /admin/billing/details both sit behind the normal billing-active
    // gate -- an inactive tenant simply won't get these numbers, which is fine since the
    // status card above already explains why access is blocked.
    apiGet<UsageStatus>("/admin/usage").then(setUsage).catch(() => undefined);
    apiGet<BillingDetails>("/admin/billing/details").then(setDetails).catch(() => undefined);
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

  async function cancelSubscription() {
    setCanceling(true);
    try {
      const result = await apiPost<{ cancelAtPeriodEnd: boolean; currentPeriodEnd: string | null }>("/admin/billing/cancel");
      notify(
        result.currentPeriodEnd
          ? `解約を予約しました。${new Date(result.currentPeriodEnd).toLocaleDateString("ja-JP")}まではご利用いただけます。`
          : "解約を予約しました。",
        "success",
      );
      setDetails((prev) =>
        prev?.subscription ? { ...prev, subscription: { ...prev.subscription, cancelAtPeriodEnd: true } } : prev,
      );
      setConfirmingCancel(false);
    } catch (err) {
      notify(`解約の予約に失敗しました: ${(err as Error).message}`);
    } finally {
      setCanceling(false);
    }
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>請求・プラン</h1>
            <p className="page-lead">プランと支払い状況の確認、Stripeでのお支払い方法の管理ができます。</p>
          </div>
        </div>

        {!ready || loading ? (
          <div className="card card-pad">読み込み中...</div>
        ) : billing ? (
          <div className="card card-pad" style={{ maxWidth: 480 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.4rem" }}>
              <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <strong>{billing.plan === "standard" ? "スタンダードプラン" : billing.plan}</strong>
                {billing.testMode && <span className="badge">デモ契約</span>}
              </span>
              <span className={`badge ${billing.status === "active" ? "ok" : "warn"}`}>{STATUS_LABEL[billing.status]}</span>
            </div>

            {details?.subscription?.priceAmount != null && details.subscription.priceCurrency && (
              <div style={{ marginTop: "0.75rem", fontSize: "1.1rem", fontWeight: 700 }}>
                {formatPrice(details.subscription.priceAmount, details.subscription.priceCurrency, details.subscription.priceInterval)}
              </div>
            )}
            {details?.subscription?.currentPeriodEnd && (
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "var(--fg-subtle)" }}>
                {details.subscription.cancelAtPeriodEnd ? "契約終了日" : "次回更新日"}:{" "}
                {new Date(details.subscription.currentPeriodEnd).toLocaleDateString("ja-JP")}
              </p>
            )}
            {details?.subscription?.cancelAtPeriodEnd && (
              <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "var(--warn)" }}>
                解約予約済みです。上記の日付でご利用が終了します。
              </p>
            )}

            {STATUS_MESSAGE[billing.status] && (
              <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>{STATUS_MESSAGE[billing.status]}</p>
            )}
            <button type="button" onClick={openPortal} disabled={openingPortal} style={{ marginTop: "1.25rem", width: "100%" }}>
              {openingPortal ? "開いています..." : "Stripeでお支払い方法を管理"}
            </button>
            <p style={{ marginTop: "0.6rem", fontSize: "0.76rem", color: "var(--fg-subtle)" }}>
              現在はスタンダードプランのみご提供しています。他プランへの変更はご用意がありません。
            </p>
          </div>
        ) : null}

        {details?.paymentMethod && (
          <div className="card card-pad" style={{ maxWidth: 480, marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "0.95rem", margin: 0 }}>お支払い方法</h2>
            <p style={{ margin: "0.6rem 0 0", fontSize: "0.9rem" }}>
              {details.paymentMethod.brand.toUpperCase()} •••• {details.paymentMethod.last4}{" "}
              <span style={{ color: "var(--fg-subtle)" }}>
                有効期限 {details.paymentMethod.expMonth}/{details.paymentMethod.expYear}
              </span>
            </p>
          </div>
        )}

        {details && details.invoices.length > 0 && (
          <div className="card card-pad" style={{ maxWidth: 480, marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem" }}>請求書・領収書</h2>
            <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {details.invoices.map((inv) => (
                <li
                  key={inv.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "0.5rem 0",
                    borderBottom: "1px solid var(--border)",
                    fontSize: "0.85rem",
                  }}
                >
                  <span>{new Date(inv.createdAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long" })}分</span>
                  <span style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
                    {usdFromCents(inv.amountUsdCents)}
                    {inv.hostedInvoiceUrl && (
                      <a href={inv.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                        表示
                      </a>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {usage && (
          <div className="card card-pad" style={{ maxWidth: 480, marginTop: "1.25rem" }}>
            <h2 style={{ fontSize: "0.95rem", margin: 0 }}>利用状況</h2>
            <UsageRow label="商品登録数" used={usage.products.used} limit={usage.products.limit} />
            <UsageRow label="AI生成(今月)" used={usage.aiGenerations.used} limit={usage.aiGenerations.limit} />
          </div>
        )}

        {billing?.status === "active" && details?.subscription && !details.subscription.cancelAtPeriodEnd && (
          <div className="card card-pad" style={{ maxWidth: 480, marginTop: "1.25rem" }}>
            {!confirmingCancel ? (
              <button type="button" className="secondary" style={{ color: "var(--danger)", width: "100%" }} onClick={() => setConfirmingCancel(true)}>
                契約を解約
              </button>
            ) : (
              <>
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
                  解約すると
                  {details.subscription.currentPeriodEnd
                    ? `次回更新日(${new Date(details.subscription.currentPeriodEnd).toLocaleDateString("ja-JP")})`
                    : "次回更新日"}
                  にご利用が終了します。それまでは引き続きご利用いただけます。
                </p>
                <div style={{ display: "flex", gap: "0.6rem" }}>
                  <button type="button" className="secondary" onClick={() => setConfirmingCancel(false)} style={{ flex: 1 }}>
                    やめる
                  </button>
                  <button type="button" onClick={cancelSubscription} disabled={canceling} style={{ flex: 1, background: "var(--danger)" }}>
                    {canceling ? "処理中..." : "解約する"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function usdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
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
