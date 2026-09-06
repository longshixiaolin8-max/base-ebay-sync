"use client";

import { confirmSignIn, signIn } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";

type Stage =
  | { step: "credentials" }
  | { step: "totp-setup"; sharedSecret: string; setupUri: string }
  | { step: "totp-code" };

function Brand() {
  return (
    <div className="auth-brand">
      <span className="app-brand-mark">AI</span>
      <strong>AI EC運営プラットフォーム</strong>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "credentials" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (stage.step !== "totp-setup") {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(stage.setupUri, { width: 200, margin: 1 })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [stage]);

  function handleNextStep(nextStep: { signInStep: string; totpSetupDetails?: { sharedSecret: string; getSetupUri: (appName: string) => URL } }) {
    if (nextStep.signInStep === "CONTINUE_SIGN_IN_WITH_TOTP_SETUP" && nextStep.totpSetupDetails) {
      setStage({
        step: "totp-setup",
        sharedSecret: nextStep.totpSetupDetails.sharedSecret,
        setupUri: nextStep.totpSetupDetails.getSetupUri("AI EC Platform Admin").toString(),
      });
    } else if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") {
      setStage({ step: "totp-code" });
    } else {
      // Other challenge types (SMS, custom, new-password) aren't issued by this user
      // pool's current config -- surfaced as a message rather than silently stuck.
      setError(`未対応の追加認証手順です: ${nextStep.signInStep}`);
    }
  }

  async function onSubmitCredentials(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      ensureAmplifyConfigured();
      const result = await signIn({ username: email, password });
      if (result.isSignedIn) {
        router.replace("/dashboard");
      } else {
        handleNextStep(result.nextStep);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmitCode(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await confirmSignIn({ challengeResponse: code });
      if (result.isSignedIn) {
        router.replace("/dashboard");
      } else {
        handleNextStep(result.nextStep);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (stage.step === "totp-setup" || stage.step === "totp-code") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>認証アプリの確認コード</h1>
          {stage.step === "totp-setup" && (
            <div style={{ marginTop: "1rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
              <p style={{ margin: 0 }}>
                初回ログインです。認証アプリ(Google Authenticator、1Password等)でQRコードを読み取るか、下のキーを手動で登録してください。
              </p>
              {qrDataUrl && (
                <div className="qr-wrap">
                  <img src={qrDataUrl} alt="TOTP設定用QRコード" width={200} height={200} />
                </div>
              )}
              <code style={{ display: "block", padding: "0.5rem", background: "var(--neutral-soft)", borderRadius: 6, wordBreak: "break-all" }}>
                {stage.sharedSecret}
              </code>
            </div>
          )}
          <form onSubmit={onSubmitCode} style={{ marginTop: "1.25rem" }}>
            <div className="auth-field">
              <label>
                6桁の確認コード
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  autoFocus
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
            </div>
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" disabled={submitting} style={{ width: "100%" }}>
              {submitting ? "確認中..." : "確認してサインイン"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        <h1>管理者ログイン</h1>
        <form onSubmit={onSubmitCredentials} style={{ marginTop: "1.25rem" }}>
          <div className="auth-field">
            <label>
              メールアドレス
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          <div className="auth-field">
            <label>
              パスワード
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "サインイン中..." : "サインイン"}
          </button>
        </form>
        <p className="auth-footnote">
          アカウントは管理者が事前に発行します(セルフサインアップ不可)。このユーザープールは認証アプリによる確認コードの入力が必須です。
        </p>
      </div>
    </div>
  );
}
