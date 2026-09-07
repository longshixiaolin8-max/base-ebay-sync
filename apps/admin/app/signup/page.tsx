"use client";

import { type FormEvent, useState } from "react";
import { ApiError, publicApiPost } from "@/lib/api-client";

function Brand() {
  return (
    <div className="auth-brand">
      <span className="app-brand-mark">AI</span>
      <strong>AI EC運営プラットフォーム</strong>
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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
        <h1>アカウント登録(ベータ版)</h1>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          招待コードをお持ちの方のみご登録いただけます。登録後、Stripeのテストモード決済画面に移動します(実際の請求は発生しません)。
        </p>
        <form onSubmit={onSubmit} style={{ marginTop: "1.25rem" }}>
          <div className="auth-field">
            <label>
              会社名 / 屋号
              <input type="text" required autoFocus value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
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
              <input
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
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
        </form>
        <p className="auth-footnote">
          すでにアカウントをお持ちの方は<a href="/login">こちらからログイン</a>してください。
        </p>
      </div>
    </div>
  );
}
