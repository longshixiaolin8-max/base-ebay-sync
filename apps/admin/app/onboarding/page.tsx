"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { BoxIcon, CartIcon, CheckIcon, PlugIcon } from "@/components/icons";
import { OnboardingStepper } from "@/components/OnboardingStepper";

interface OAuthStatus {
  base: boolean;
  ebay: boolean;
}

/**
 * The one screen that ties together three already-implemented, but previously
 * unreachable-from-the-UI, backend capabilities: the authenticated per-tenant OAuth
 * authorize-url endpoints (GET /admin/oauth/{channel}/authorize-url -- mints a signed
 * state server-side from the caller's own JWT, unlike the legacy public /oauth/*
 * /authorize routes), eBay business-policy setup (POST /admin/ebay/policies), and the
 * existing-eBay-listing linking flow (/products/link-existing, built and verified in an
 * earlier round -- reused here rather than re-implemented inline). Restructured as a
 * 4-step wizard (接続/設定/紐付け/初回出品) per the reference mockup.
 */
export default function OnboardingPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [tenantName, setTenantName] = useState<string | null>(null);
  const [policiesDone, setPoliciesDone] = useState(false);
  const [unmanagedCount, setUnmanagedCount] = useState<number | null>(null);
  const [pendingApprovalCount, setPendingApprovalCount] = useState<number | null>(null);
  const [busy, setBusy] = useState<"base" | "ebay" | "policies" | null>(null);
  const [step, setStep] = useState(0);
  const [stepInitialized, setStepInitialized] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiGet<OAuthStatus>("/admin/oauth/status");
      setStatus(res);
    } catch (err) {
      notify(`接続状況の確認に失敗しました: ${(err as Error).message}`);
    }
  }, [notify]);

  useEffect(() => {
    if (!ready) return;
    void loadStatus();
    apiGet<{ name: string }>("/admin/tenant").then((res) => setTenantName(res.name)).catch(() => {});
    // The OAuth flow itself happens in a separate tab (see connect() below); when the
    // operator finishes there and switches back to this tab, refresh automatically
    // instead of requiring them to find and click a manual refresh button.
    function onFocus() {
      void loadStatus();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, loadStatus]);

  const baseDone = status?.base ?? false;
  const ebayDone = status?.ebay ?? false;

  // Land on the first step that still needs attention, based on real backend state --
  // computed once the connection status has actually loaded, not before.
  useEffect(() => {
    if (stepInitialized || !status) return;
    if (!baseDone || !ebayDone) setStep(0);
    else if (!policiesDone) setStep(1);
    else setStep(2);
    setStepInitialized(true);
  }, [status, baseDone, ebayDone, policiesDone, stepInitialized]);

  useEffect(() => {
    if (step !== 2 || !ready) return;
    apiGet<{ unmanagedListings: unknown[] }>("/admin/ebay/unmanaged-listings")
      .then((res) => setUnmanagedCount(res.unmanagedListings.length))
      .catch(() => setUnmanagedCount(null));
  }, [step, ready]);

  useEffect(() => {
    if (step !== 3 || !ready) return;
    apiGet<{ products: Array<{ status: string }> }>("/admin/products")
      .then((res) => setPendingApprovalCount(res.products.filter((p) => p.status === "ai_generated").length))
      .catch(() => setPendingApprovalCount(null));
  }, [step, ready]);

  async function connect(channel: "base" | "ebay") {
    setBusy(channel);
    try {
      const res = await apiGet<{ url: string }>(`/admin/oauth/${channel}/authorize-url`);
      window.open(res.url, "_blank", "noopener,noreferrer");
      notify(`${channel === "base" ? "BASE" : "eBay"}の連携画面を別タブで開きました。完了したらこのタブに戻ってきてください。`);
    } catch (err) {
      notify(`連携の開始に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function setUpPolicies() {
    setBusy("policies");
    try {
      await apiPost("/admin/ebay/policies");
      setPoliciesDone(true);
      notify("eBayの事業者ポリシー(配送・支払い・返品)を作成しました。", "success");
    } catch (err) {
      notify(`ポリシーの作成に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>導入設定</h1>
            <p className="page-lead">
              BASEとeBayを接続し、eBayの出品に必要な事業者ポリシーを設定します。既存のeBay出品がある場合は紐付けも行います。
            </p>
          </div>
        </div>

        <div style={{ maxWidth: "640px" }}>
          <OnboardingStepper current={step} />

          {step === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="card card-pad" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <span
                  className={`status-dot ${baseDone ? "ok" : "warn"}`}
                  style={{ width: "2.2rem", height: "2.2rem", borderRadius: "var(--radius-sm)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 700 }}
                >
                  {baseDone ? <CheckIcon /> : "B"}
                </span>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: 0 }}>BASE</h3>
                  {baseDone ? (
                    <>
                      <span className="badge ok">接続済み</span>
                      {tenantName && <div style={{ fontSize: "0.82rem", color: "var(--fg-subtle)", marginTop: "0.3rem" }}>ショップ名 {tenantName}</div>}
                    </>
                  ) : (
                    <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem", color: "var(--fg-muted)" }}>未接続</p>
                  )}
                </div>
                <button type="button" className={baseDone ? "secondary" : undefined} onClick={() => connect("base")} disabled={busy === "base"}>
                  {busy === "base" ? "処理中..." : baseDone ? "接続を管理" : "BASEに接続"}
                </button>
              </div>

              <div className="card card-pad" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                <span
                  className={`status-dot ${ebayDone ? "ok" : "warn"}`}
                  style={{ width: "2.2rem", height: "2.2rem", borderRadius: "var(--radius-sm)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontWeight: 700 }}
                >
                  {ebayDone ? <CheckIcon /> : "e"}
                </span>
                <div style={{ flex: 1 }}>
                  <h3 style={{ margin: 0 }}>eBay</h3>
                  <p style={{ margin: "0.3rem 0 0", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
                    {ebayDone ? <span className="badge ok">接続済み</span> : "接続先の画面でアクセスを許可します。"}
                  </p>
                </div>
                <button type="button" className={ebayDone ? "secondary" : undefined} onClick={() => connect("ebay")} disabled={busy === "ebay"}>
                  {busy === "ebay" ? "処理中..." : ebayDone ? "接続を管理" : "eBayに接続"}
                </button>
              </div>

              <div className="card card-pad">
                <div className="section-eyebrow">必要な情報</div>
                <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)", margin: "0.4rem 0 0.6rem" }}>以下の情報を連携します。</p>
                <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                    <BoxIcon /> 商品
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                    <PlugIcon /> 在庫
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.85rem" }}>
                    <CartIcon /> 注文
                  </span>
                </div>
              </div>

              <div className="auth-callout">
                <span>商品が自動で出品されることはありません。接続後に、AIが生成した出品ドラフトを確認・承認してから出品します。</span>
              </div>

              <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
                <button type="button" onClick={() => setStep(1)} disabled={!baseDone || !ebayDone}>
                  次へ
                </button>
              </div>
              <Link href="/dashboard" style={{ textAlign: "center", fontSize: "0.85rem" }}>
                保存して後で続ける
              </Link>
            </div>
          )}

          {step === 1 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="card card-pad">
                <h3 style={{ margin: 0 }}>eBayの事業者ポリシーを設定する</h3>
                <p style={{ margin: "0.4rem 0 0.8rem", color: "var(--fg-muted)", fontSize: "0.85rem", lineHeight: 1.6 }}>
                  配送・支払い・返品ポリシーをeBay側に作成します。eBayへの出品にはこの設定が必須です。※
                  既に設定済みの場合は再実行すると重複して作成されるため、初回のみ実行してください。
                </p>
                {policiesDone ? (
                  <span className="badge ok">完了</span>
                ) : (
                  <button type="button" onClick={setUpPolicies} disabled={busy === "policies"}>
                    {busy === "policies" ? "処理中..." : "ポリシーを作成"}
                  </button>
                )}
              </div>
              <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
                <button type="button" className="secondary" onClick={() => setStep(0)}>
                  ← 戻る
                </button>
                <button type="button" onClick={() => setStep(2)} disabled={!policiesDone}>
                  次へ
                </button>
              </div>
            </div>
          )}

          {step === 2 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="card card-pad">
                <h3 style={{ margin: 0 }}>既存のeBay出品を紐付ける</h3>
                <p style={{ margin: "0.4rem 0 0.8rem", color: "var(--fg-muted)", fontSize: "0.85rem", lineHeight: 1.6 }}>
                  導入前からeBayに出品していた商品がある場合、紐付けないまま出品を進めると重複して新規出品される可能性があります。
                </p>
                {unmanagedCount === null ? (
                  <p style={{ fontSize: "0.85rem", color: "var(--fg-subtle)" }}>確認中...</p>
                ) : unmanagedCount === 0 ? (
                  <span className="badge ok">紐付けが必要な出品はありません</span>
                ) : (
                  <>
                    <span className="badge warn">{unmanagedCount}件が未紐付けです</span>
                    <Link href="/products/link-existing?onboarding=1" className="button" style={{ display: "block", textAlign: "center", marginTop: "0.8rem" }}>
                      紐付けを開始
                    </Link>
                  </>
                )}
              </div>
              <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
                <button type="button" className="secondary" onClick={() => setStep(1)}>
                  ← 戻る
                </button>
                <button type="button" onClick={() => setStep(3)}>
                  次へ
                </button>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <div className="card card-pad">
                <h3 style={{ margin: 0 }}>初回出品</h3>
                <p style={{ margin: "0.4rem 0 0.8rem", color: "var(--fg-muted)", fontSize: "0.85rem", lineHeight: 1.6 }}>
                  BASEの商品は次回の自動取込(最短15分以内)で取り込まれます。取り込まれた商品はAIが出品ドラフトを作成し、
                  「商品マスター」画面で内容を確認・承認するとeBayへの出品が始まります。
                </p>
                {pendingApprovalCount !== null && pendingApprovalCount > 0 && (
                  <span className="badge warn">承認待ちの商品 {pendingApprovalCount}件</span>
                )}
                <Link href="/products" className="button" style={{ display: "block", textAlign: "center", marginTop: "0.8rem" }}>
                  商品マスターを開く
                </Link>
              </div>
              <div className="page-actions" style={{ position: "static", background: "none", border: "none", padding: 0 }}>
                <button type="button" className="secondary" onClick={() => setStep(2)}>
                  ← 戻る
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
