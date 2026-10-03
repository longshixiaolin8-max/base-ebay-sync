"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, publicApiGet, publicApiPost } from "@/lib/api-client";
import { EyeIcon, EyeOffIcon } from "@/components/icons";
import { OtpInput } from "@/components/OtpInput";

interface PublicPricing {
  unitAmount: number;
  currency: string;
  interval: string;
  trialDays: number;
  live: boolean;
}

type Stage = "account" | "verify";

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

const STEPS = ["アカウント情報", "メール確認", "お支払い設定", "2段階認証"];

function Stepper({ stage }: { stage: Stage }) {
  const active = stage === "account" ? 0 : 1;
  return (
    <div className="stepper">
      {STEPS.map((label, i) => (
        <div key={label} style={{ display: "contents" }}>
          <div className="stepper-item" data-state={i === active ? "active" : i < active ? "done" : "pending"}>
            <span className="stepper-dot">{i + 1}</span>
            <span className="stepper-label">{label}</span>
          </div>
          {i < STEPS.length - 1 && <div className="stepper-connector" />}
        </div>
      ))}
    </div>
  );
}

function formatPrice(pricing: PublicPricing | null): string {
  if (!pricing) return "料金を確認中";
  const amount = pricing.unitAmount / 100;
  const label = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: pricing.currency.toUpperCase(),
    maximumFractionDigits: pricing.currency.toLowerCase() === "jpy" ? 0 : 2,
  }).format(amount);
  return `${label} / ${pricing.interval === "month" ? "月" : pricing.interval}`;
}

export default function SignupPage() {
  const [stage, setStage] = useState<Stage>("account");
  const [companyName, setCompanyName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [code, setCode] = useState("");
  const [pricing, setPricing] = useState<PublicPricing | null>(null);
  const [pricingUnavailable, setPricingUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    publicApiGet<PublicPricing>("/public/pricing")
      .then(setPricing)
      .catch(() => setPricingUnavailable(true));
  }, []);

  async function startSignup(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await publicApiPost("/signup", {
        action: "start",
        companyName,
        name: name || undefined,
        email,
        password,
        acceptedTerms,
      });
      setStage("verify");
      setCode("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("このメールアドレスはすでに登録されています。ログインまたはパスワード再設定をお試しください。");
      } else {
        setError("登録を開始できませんでした。入力内容を確認してもう一度お試しください。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmEmail(value: string) {
    if (submitting || value.length !== 6) return;
    setSubmitting(true);
    setError(null);
    try {
      const { checkoutUrl } = await publicApiPost<{ checkoutUrl: string }>("/signup", {
        action: "confirm",
        companyName,
        email,
        confirmationCode: value,
        acceptedTerms,
      });
      window.location.href = checkoutUrl;
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setError("現在、新規のお支払い受付を準備中です。しばらくしてからもう一度お試しください。");
      } else {
        setError("確認コードを確認できませんでした。最新の6桁コードを入力してください。");
      }
      setCode("");
      setSubmitting(false);
    }
  }

  async function resendCode() {
    setResending(true);
    setError(null);
    try {
      await publicApiPost("/signup", { action: "resend", email });
    } catch {
      setError("確認コードを再送できませんでした。しばらくしてからお試しください。");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        <h1>新規登録</h1>
        <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
          {pricingUnavailable
            ? "新規受付状況を確認できません。"
            : `${pricing?.trialDays ?? 30}日間無料。その後 ${formatPrice(pricing)} で継続できます。`}
        </p>

        <div style={{ marginTop: "1.25rem" }}>
          <Stepper stage={stage} />
        </div>

        {stage === "account" ? (
          <form onSubmit={startSignup}>
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
                    autoComplete="new-password"
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
                12文字以上で、大文字・小文字・数字・記号を組み合わせてください。
              </p>
            </div>

            <label style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start", fontSize: "0.8rem", margin: "1rem 0" }}>
              <input
                type="checkbox"
                checked={acceptedTerms}
                onChange={(e) => setAcceptedTerms(e.target.checked)}
                required
                style={{ marginTop: "0.15rem" }}
              />
              <span>
                <Link href="/terms" target="_blank">利用規約</Link> と{" "}
                <Link href="/privacy" target="_blank">プライバシーポリシー</Link>に同意します。
              </span>
            </label>

            {error && <p className="auth-error">{error}</p>}
            <button type="submit" disabled={submitting || !acceptedTerms || pricingUnavailable} style={{ width: "100%" }}>
              {submitting ? "送信中..." : "確認コードを受け取る"}
            </button>
          </form>
        ) : (
          <div style={{ marginTop: "1.25rem" }}>
            <p style={{ fontSize: "0.85rem", color: "var(--fg-muted)", lineHeight: 1.7 }}>
              <strong>{email}</strong> に6桁の確認コードを送りました。メールアドレス確認後、Stripeの安全な決済画面へ進みます。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void confirmEmail(code);
              }}
              style={{ marginTop: "1rem" }}
            >
              <OtpInput value={code} onChange={setCode} onComplete={confirmEmail} disabled={submitting} />
              {error && <p className="auth-error" style={{ marginTop: "1rem" }}>{error}</p>}
              <button type="submit" disabled={submitting || code.length !== 6} style={{ width: "100%", marginTop: "1rem" }}>
                {submitting ? "確認中..." : "メール確認してお支払い設定へ"}
              </button>
            </form>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "0.9rem", gap: "0.75rem" }}>
              <button type="button" className="secondary" onClick={() => setStage("account")}>
                入力内容に戻る
              </button>
              <button type="button" className="secondary" disabled={resending} onClick={resendCode}>
                {resending ? "再送中..." : "コードを再送"}
              </button>
            </div>
          </div>
        )}

        <p className="auth-footnote">
          すでにアカウントをお持ちの方は<Link href="/login">ログイン</Link>
        </p>
      </div>
    </div>
  );
}
