"use client";

import { confirmResetPassword, resetPassword } from "aws-amplify/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { OtpInput } from "@/components/OtpInput";

function Brand() {
  return (
    <div className="auth-brand">
      <span className="app-brand-mark">AI</span>
      <strong>
        BASE <span className="app-brand-ebay">eBay</span> Sync
      </strong>
    </div>
  );
}

type Stage = { step: "request" } | { step: "confirm" };

/**
 * Self-service password reset, using Cognito's built-in email-based account recovery
 * (AuthStack's userPool already sets accountRecovery: EMAIL_ONLY, so this needs no new
 * infra -- Cognito sends the confirmation code itself). This is separate from the
 * MFA-device-loss recovery flow (still admin-assisted only, see login page and the
 * README runbook): losing a password is self-serviceable, losing the authenticator app
 * is not, since that would let anyone who resets a password also bypass MFA.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ step: "request" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onRequestCode(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      ensureAmplifyConfigured();
      await resetPassword({ username: email });
      setStage({ step: "confirm" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmWithCode(value: string) {
    if (submitting || newPassword.length < 12) return;
    setSubmitting(true);
    setError(null);
    try {
      await confirmResetPassword({ username: email, confirmationCode: value, newPassword });
      setNotice("パスワードを更新しました。新しいパスワードでログインしてください。");
      setTimeout(() => router.replace("/login"), 1500);
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  if (stage.step === "confirm") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>確認コードの入力</h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
            {email} 宛に確認コードを送信しました。コードと新しいパスワードを入力してください。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void confirmWithCode(code);
            }}
            style={{ marginTop: "1.25rem" }}
          >
            <div style={{ marginBottom: "1rem" }}>
              <OtpInput value={code} onChange={setCode} disabled={submitting} />
            </div>
            <div className="auth-field">
              <label>
                新しいパスワード
                <input
                  type="password"
                  required
                  minLength={12}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </label>
            </div>
            {error && <p className="auth-error">{error}</p>}
            {notice && (
              <p className="auth-error" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
                {notice}
              </p>
            )}
            <button type="submit" disabled={submitting || code.length !== 6 || newPassword.length < 12} style={{ width: "100%" }}>
              {submitting ? "更新中..." : "パスワードを更新"}
            </button>
          </form>
          <p className="auth-footnote">
            <Link href="/login">ログインに戻る</Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        <h1>パスワードの再設定</h1>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          登録済みのメールアドレスに確認コードを送信します。
        </p>
        <form onSubmit={onRequestCode} style={{ marginTop: "1.25rem" }}>
          <div className="auth-field">
            <label>
              メールアドレス
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "送信中..." : "確認コードを送信"}
          </button>
        </form>
        <p className="auth-footnote">
          <Link href="/login">ログインに戻る</Link>
        </p>
      </div>
    </div>
  );
}
