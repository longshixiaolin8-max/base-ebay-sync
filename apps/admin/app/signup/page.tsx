"use client";

import { type FormEvent, useState } from "react";
import { ApiError, publicApiPost } from "@/lib/api-client";
import { EyeIcon, EyeOffIcon } from "@/components/icons";

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

// The real flow this form kicks off has no separate "email confirmation" screen --
// signup's Lambda marks email_verified true immediately (see services/lambdas/signup),
// so a stepper showing a fabricated confirmation step would misrepresent what actually
// happens. These three labels match the real sequence: this form, an external redirect
// to Stripe Checkout, then (back in this app) the existing TOTP-setup screen on first
// login -- not the mockup's "メール確認" step, which doesn't exist in this system.
const STEPS = ["アカウント情報", "お支払い設定", "2段階認証"];

function Stepper() {
  return (
    <div className="stepper">
      {STEPS.map((label, i) => (
        <div key={label} style={{ display: "contents" }}>
          <div className="stepper-item" data-state={i === 0 ? "active" : "pending"}>
            <span className="stepper-dot">{i + 1}</span>
            <span className="stepper-label">{label}</span>
          </div>
          {i < STEPS.length - 1 && <div className="stepper-connector" />}
        </div>
      ))}
    </div>
  );
}

/**
 * Public self-service signup (Phase 2 of the SaaS conversion). Beta access is gated by a
 * shared invite code, not fully open self-signup -- see infra/lib/secrets-stack.ts's
 * signupCredentials. On success, /signup's own Lambda has already created the new tenant
 * and its Cognito operator account (see services/lambdas/signup); this page's only job
 * left is to hand the browser off to the real (test-mode) Stripe Checkout page it returns.
 */
export default function SignupPage() {
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { checkoutUrl } = await publicApiPost<{ checkoutUrl: string }>("/signup", {
        companyName,
        name: name || undefined,
        email,
        password,
        inviteCode,
      });
      window.location.href = checkoutUrl;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("招待コードが正しくありません。");
      } else if (err instanceof ApiError && err.status === 409) {
        setError("このメールアドレスはすでに登録されています。ログインをお試しください。");
      } else {
        setError((err as Error).message);
      }
      setSubmitting(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        <h1>
          新規登録 <span className="badge">招待制</span>
        </h1>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          招待コードをお持ちの方のみご登録いただけます。
        </p>
        <div style={{ marginTop: "1.25rem" }}>
          <Stepper />
        </div>
        <form onSubmit={onSubmit}>
          <div className="auth-field">
            <label>
              ショップ名
              <input type="text" required autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
            </label>
          </div>
          <div className="auth-field">
            <label>
              お名前(任意)
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
          </div>
          <div className="auth-field">
            <label>
              メールアドレス
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          <div className="auth-field">
            <label>
              パスワード
              <div className="auth-password-field">
                <input
                  type={passwordVisible ? "text" : "password"}
                  required
                  minLength={12}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={() => setPasswordVisible((v) => !v)}
                  aria-label={passwordVisible ? "パスワードを隠す" : "パスワードを表示"}
                >
                  {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </label>
            <p style={{ fontSize: "0.75rem", color: "var(--fg-subtle)", marginTop: "0.3rem" }}>
              半角英数字・記号を組み合わせて、12文字以上で入力してください。
            </p>
          </div>
          <div className="auth-field">
            <label>
              招待コード
              <input type="text" required value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
            </label>
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "処理中..." : "登録して決済へ進む"}
          </button>
          <p style={{ fontSize: "0.75rem", color: "var(--fg-subtle)", marginTop: "0.6rem", textAlign: "center" }}>
            この登録操作自体に料金は発生しません。次にStripeの決済画面(テストモード)に移動します。
          </p>
        </form>
        <p className="auth-footnote">
          すでにアカウントをお持ちの方は<a href="/login">こちらからログイン</a>してください。
        </p>
      </div>
    </div>
  );
}
