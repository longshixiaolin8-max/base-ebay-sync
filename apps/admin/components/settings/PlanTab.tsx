"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch, apiPost } from "@/lib/api-client";
import { formatStripeAmount, planLabel } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { BillingDetails, BillingStatus, TenantInfo, UsageStatus } from "./types";

const STATUS_LABEL: Record<BillingStatus["status"], string> = {
  pending_payment: "決済待ち",
  active: "有効",
  past_due: "支払い失敗",
  canceled_grace: "解約済み(閲覧可能)",
  canceled: "解約済み",
};

const STATUS_MESSAGE: Record<BillingStatus["status"], string | null> = {
  pending_payment: "決済が完了していません。Stripeの決済画面で登録を完了してください。",
  active: null,
  past_due: "お支払いに失敗しました。下のボタンからお支払い方法を更新してください。",
  // canceled_grace's message is built dynamically below (it needs the actual end date);
  // this entry is unused but kept so the Record stays exhaustive over the status union.
  canceled_grace: null,
  canceled: "サブスクリプションが解約されています。継続するには再度お手続きください。",
};

function formatPrice(amount: number, currency: string, interval: string | null): string {
  const formatted = formatStripeAmount(amount, currency);
  return interval ? `${formatted} / ${interval === "month" ? "月" : interval === "year" ? "年" : interval}` : formatted;
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
        <div style={{ width: `${ratio * 100}%`, height: "100%", background: nearLimit ? "var(--danger)" : "var(--accent)" }} />
      </div>
    </div>
  );
}

const TIMEZONE_OPTIONS = ["Asia/Tokyo", "UTC", "America/Los_Angeles", "America/New_York"];
const LANGUAGE_OPTIONS: Record<string, string> = { ja: "日本語", en: "English" };

export default function PlanTab() {
  const { notify } = useToast();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<UsageStatus | null>(null);
  const [details, setDetails] = useState<BillingDetails | null>(null);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [tenantForm, setTenantForm] = useState<Pick<TenantInfo, "name" | "address" | "timezone" | "language" | "contactEmail"> | null>(null);
  const [savingTenant, setSavingTenant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [openingCheckout, setOpeningCheckout] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  useEffect(() => {
    apiGet<BillingStatus>("/admin/billing/status")
      .then(setBilling)
      .catch((err) => notify(`請求情報の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
    // /admin/usage and /admin/billing/details both sit behind the normal billing-active
    // gate -- an inactive tenant simply won't get these numbers, which is fine since the
    // status card above already explains why access is blocked.
    apiGet<UsageStatus>("/admin/usage").then(setUsage).catch(() => undefined);
    apiGet<BillingDetails>("/admin/billing/details").then(setDetails).catch(() => undefined);
    apiGet<TenantInfo>("/admin/tenant")
      .then((res) => {
        setTenant(res);
        setTenantForm({ name: res.name, address: res.address, timezone: res.timezone, language: res.language, contactEmail: res.contactEmail });
      })
      .catch((err) => notify(`テナント情報の取得に失敗しました: ${(err as Error).message}`));
  }, []);

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

  async function resumeCheckout() {
    setOpeningCheckout(true);
    try {
      const { url } = await apiPost<{ url: string }>("/admin/billing/checkout-session");
      window.location.href = url;
    } catch (err) {
      notify(`お支払い設定を再開できませんでした: ${(err as Error).message}`);
      setOpeningCheckout(false);
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
      setDetails((prev) => (prev?.subscription ? { ...prev, subscription: { ...prev.subscription, cancelAtPeriodEnd: true } } : prev));
      setConfirmingCancel(false);
    } catch (err) {
      notify(`解約の予約に失敗しました: ${(err as Error).message}`);
    } finally {
      setCanceling(false);
    }
  }

  async function saveTenant() {
    if (!tenantForm) return;
    setSavingTenant(true);
    try {
      const updated = await apiPatch<TenantInfo>("/admin/tenant", tenantForm);
      setTenant(updated);
      notify("テナント情報を更新しました。", "success");
    } catch (err) {
      notify(`テナント情報の更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setSavingTenant(false);
    }
  }

  if (loading) return <div className="card card-pad">読み込み中...</div>;

  return (
    <div className="settings-grid">
      {tenant && tenantForm && (
        <Card>
          <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.75rem" }}>テナント情報</h2>
          <label className="settings-field">
            事業者名
            <input value={tenantForm.name} onChange={(e) => setTenantForm({ ...tenantForm, name: e.target.value })} />
          </label>
          <label className="settings-field">
            所在地
            <input
              value={tenantForm.address ?? ""}
              onChange={(e) => setTenantForm({ ...tenantForm, address: e.target.value })}
              placeholder="未設定"
            />
          </label>
          <label className="settings-field">
            タイムゾーン
            <select value={tenantForm.timezone ?? "Asia/Tokyo"} onChange={(e) => setTenantForm({ ...tenantForm, timezone: e.target.value })}>
              {TIMEZONE_OPTIONS.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            表示言語
            <select value={tenantForm.language ?? "ja"} onChange={(e) => setTenantForm({ ...tenantForm, language: e.target.value })}>
              {Object.entries(LANGUAGE_OPTIONS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            連絡先メールアドレス
            <input
              type="email"
              value={tenantForm.contactEmail ?? ""}
              onChange={(e) => setTenantForm({ ...tenantForm, contactEmail: e.target.value })}
              placeholder="未設定"
            />
          </label>
          <div className="settings-form-actions">
            <button type="button" onClick={saveTenant} disabled={savingTenant}>
              {savingTenant ? "保存中..." : "保存"}
            </button>
          </div>
        </Card>
      )}

      {billing && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "0.4rem" }}>
            <span style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <strong>{planLabel(billing.plan)}</strong>
              {billing.testMode && <Badge>デモ契約</Badge>}
            </span>
            <Badge tone={billing.status === "active" ? "ok" : "warn"}>{STATUS_LABEL[billing.status]}</Badge>
          </div>

          {details?.subscription?.priceAmount != null && details.subscription.priceCurrency && (
            <div style={{ marginTop: "0.75rem", fontSize: "1.1rem", fontWeight: 700 }}>
              {formatPrice(details.subscription.priceAmount, details.subscription.priceCurrency, details.subscription.priceInterval)}
            </div>
          )}
          {details?.subscription?.currentPeriodEnd && (
            <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "var(--fg-subtle)" }}>
              {details.subscription.cancelAtPeriodEnd ? "契約終了日" : details.subscription.trialEnd ? "無料期間終了日(初回請求日)" : "次回更新日"}:{" "}
              {new Date(details.subscription.currentPeriodEnd).toLocaleDateString("ja-JP")}
            </p>
          )}
          {details?.subscription?.trialEnd && !details.subscription.cancelAtPeriodEnd && (
            <div className="auth-callout" style={{ marginTop: "0.75rem" }}>
              <span>
                現在無料期間中です。{new Date(details.subscription.trialEnd).toLocaleDateString("ja-JP")}
                まではご利用料金は発生しません。それ以降は登録済みのお支払い方法へ自動的に請求されます。
              </span>
            </div>
          )}
          {details?.subscription?.cancelAtPeriodEnd && (
            <p style={{ margin: "0.3rem 0 0", fontSize: "0.82rem", color: "var(--warn)" }}>解約予約済みです。上記の日付でご利用が終了します。</p>
          )}
          {billing.status === "canceled_grace" && billing.gracePeriodEndsAt && (
            <div className="auth-callout warn" style={{ marginTop: "1rem" }}>
              <span>
                契約は終了しています。データの閲覧・CSVエクスポートは{new Date(billing.gracePeriodEndsAt).toLocaleDateString("ja-JP")}
                まで可能です。それ以降はアクセスできなくなります。
              </span>
            </div>
          )}
          {STATUS_MESSAGE[billing.status] && (
            <p style={{ marginTop: "1rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>{STATUS_MESSAGE[billing.status]}</p>
          )}
          {billing.status === "pending_payment" ? (
            <button type="button" onClick={resumeCheckout} disabled={openingCheckout} style={{ marginTop: "1.25rem", width: "100%" }}>
              {openingCheckout ? "開いています..." : "Stripeでお支払い設定を続ける"}
            </button>
          ) : (
            <button type="button" onClick={openPortal} disabled={openingPortal} style={{ marginTop: "1.25rem", width: "100%" }}>
              {openingPortal ? "開いています..." : "Stripeでお支払い方法を管理"}
            </button>
          )}
          <p style={{ marginTop: "0.6rem", fontSize: "0.76rem", color: "var(--fg-subtle)" }}>
            現在はスタンダードプランのみご提供しています。他プランへの変更はご用意がありません。
          </p>

          {details?.paymentMethod && (
            <p style={{ marginTop: "1rem", fontSize: "0.85rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
              {details.paymentMethod.brand.toUpperCase()} •••• {details.paymentMethod.last4}{" "}
              <span style={{ color: "var(--fg-subtle)" }}>
                有効期限 {details.paymentMethod.expMonth}/{details.paymentMethod.expYear}
              </span>
            </p>
          )}
          {details?.billingEmail && (
            <p style={{ margin: "0.3rem 0 0", fontSize: "0.8rem", color: "var(--fg-subtle)" }}>請求先メール: {details.billingEmail}</p>
          )}

          {billing.status === "active" && details?.subscription && !details.subscription.cancelAtPeriodEnd && (
            <div style={{ marginTop: "1rem", borderTop: "1px solid var(--border)", paddingTop: "0.75rem" }}>
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
        </Card>
      )}

      {usage && (
        <Card>
          <h2 style={{ fontSize: "0.95rem", margin: 0 }}>利用状況</h2>
          <UsageRow label="商品登録数" used={usage.products.used} limit={usage.products.limit} />
          <UsageRow label="AI生成(今月)" used={usage.aiGenerations.used} limit={usage.aiGenerations.limit} />
          <UsageRow label="監視対象SKU数" used={usage.monitoredSkus.used} limit={usage.monitoredSkus.limit} />
        </Card>
      )}

      {details && details.invoices.length > 0 && (
        <Card>
          <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.6rem" }}>請求書・領収書</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>請求書番号</th>
                  <th>請求日</th>
                  <th>金額</th>
                  <th>ステータス</th>
                  <th>ダウンロード</th>
                </tr>
              </thead>
              <tbody>
                {details.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td>{inv.number ?? inv.id}</td>
                    <td>{new Date(inv.createdAt).toLocaleDateString("ja-JP")}</td>
                    <td>{formatStripeAmount(inv.amountMinorUnits, inv.currency)}</td>
                    <td>
                      <Badge tone={inv.status === "paid" ? "ok" : "neutral"}>{inv.status ?? "—"}</Badge>
                    </td>
                    <td>
                      {inv.hostedInvoiceUrl ? (
                        <a href={inv.hostedInvoiceUrl} target="_blank" rel="noopener noreferrer">
                          表示
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
