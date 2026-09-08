"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { CheckIcon } from "@/components/icons";

interface OAuthStatus {
  base: boolean;
  ebay: boolean;
}

/**
 * The one screen that ties together three already-implemented, but previously
 * unreachable-from-the-UI, backend capabilities: the authenticated per-tenant OAuth
 * authorize-url endpoints (GET /admin/oauth/{channel}/authorize-url -- mints a signed
 * state server-side from the caller's own JWT, unlike the legacy public /oauth/*
 * /authorize routes) and eBay business-policy setup (POST /admin/ebay/policies). Without
 * this page, a new store had no way to reach BASE/eBay connection at all short of an
 * operator hand-crafting a URL.
 */
export default function OnboardingPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [policiesDone, setPoliciesDone] = useState(false);
  const [busy, setBusy] = useState<"base" | "ebay" | "policies" | null>(null);

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
    // The OAuth flow itself happens in a separate tab (see connect() below); when the
    // operator finishes there and switches back to this tab, refresh automatically
    // instead of requiring them to find and click a manual refresh button.
    function onFocus() {
      void loadStatus();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready, loadStatus]);

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

  const baseDone = status?.base ?? false;
  const ebayDone = status?.ebay ?? false;

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>導入設定</h1>
            <p className="page-lead">
              BASEとeBayを接続し、eBayの出品に必要な事業者ポリシーを設定します。完了すると、BASEの商品が自動的に取り込まれ、AIがeBay向けの出品ドラフトを作成し始めます。
            </p>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", maxWidth: "640px" }}>
          <OnboardingStep
            number={1}
            title="BASEアカウントを接続する"
            description="BASEにログインし、このプラットフォームに商品・在庫情報の取得を許可します。"
            done={baseDone}
            busy={busy === "base"}
            actionLabel="BASEを接続"
            onAction={() => connect("base")}
          />
          <OnboardingStep
            number={2}
            title="eBayアカウントを接続する"
            description="eBayにログインし、出品・在庫更新の権限を許可します。"
            done={ebayDone}
            busy={busy === "ebay"}
            actionLabel="eBayを接続"
            onAction={() => connect("ebay")}
          />
          <OnboardingStep
            number={3}
            title="eBayの事業者ポリシーを設定する"
            description="配送・支払い・返品ポリシーをeBay側に作成します。eBayへの出品にはこの設定が必須です。※ 既に設定済みの場合は再実行すると重複して作成されるため、初回のみ実行してください。"
            done={policiesDone}
            busy={busy === "policies"}
            disabled={!ebayDone}
            actionLabel="ポリシーを作成"
            onAction={setUpPolicies}
          />
        </div>

        {baseDone && ebayDone && (
          <div className="card card-pad" style={{ marginTop: "1.25rem", maxWidth: "640px" }}>
            <strong>接続が完了しました。</strong>
            <p style={{ marginTop: "0.4rem", color: "var(--fg-muted)", fontSize: "0.88rem" }}>
              BASEの商品は次回の自動取込(最短15分以内)で取り込まれます。取り込まれた商品は「商品マスター」画面に表示され、AIが生成した出品ドラフトを確認・承認するとeBayへの出品が始まります。
              既にeBayに出品している商品がある場合は、重複出品を避けるため先に「商品マスター」→「既存eBay出品を紐付ける」から紐付けを済ませてください。
            </p>
          </div>
        )}
      </div>
    </>
  );
}

function OnboardingStep({
  number,
  title,
  description,
  done,
  busy,
  disabled,
  actionLabel,
  onAction,
}: {
  number: number;
  title: string;
  description: string;
  done: boolean;
  busy: boolean;
  disabled?: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="card card-pad" style={{ display: "flex", alignItems: "flex-start", gap: "1rem" }}>
      <span
        className={`status-dot ${done ? "ok" : "warn"}`}
        style={{ width: "1.5rem", height: "1.5rem", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: "0.15rem" }}
      >
        {done ? <CheckIcon /> : <span style={{ fontSize: "0.75rem", fontWeight: 600 }}>{number}</span>}
      </span>
      <div style={{ flex: 1 }}>
        <h3 style={{ margin: 0, fontSize: "0.98rem" }}>{title}</h3>
        <p style={{ margin: "0.3rem 0 0.8rem", color: "var(--fg-muted)", fontSize: "0.85rem", lineHeight: 1.6 }}>{description}</p>
        {!done && (
          <button type="button" onClick={onAction} disabled={busy || disabled}>
            {busy ? "処理中..." : actionLabel}
          </button>
        )}
        {done && <span className="badge ok">完了</span>}
      </div>
    </div>
  );
}
