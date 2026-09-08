"use client";

import { confirmSignIn, signIn, signOut } from "aws-amplify/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { OtpInput } from "@/components/OtpInput";
import { EyeIcon, EyeOffIcon, ShieldIcon } from "@/components/icons";

type Stage =
  | { step: "credentials" }
  | { step: "new-password" }
  | { step: "totp-setup"; sharedSecret: string; setupUri: string }
  | { step: "totp-code" };

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

function PasswordField({
  label,
  value,
  onChange,
  autoFocus,
  minLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  minLength?: number;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="auth-field">
      <label>
        {label}
        <div className="auth-password-field">
          <input
            type={visible ? "text" : "password"}
            required
            minLength={minLength}
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <button
            type="button"
            className="auth-password-toggle"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "パスワードを隠す" : "パスワードを表示"}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
      </label>
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "credentials" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showMfaHelp, setShowMfaHelp] = useState(false);

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
      setCode("");
      setStage({
        step: "totp-setup",
        sharedSecret: nextStep.totpSetupDetails.sharedSecret,
        setupUri: nextStep.totpSetupDetails.getSetupUri("BASE eBay Sync").toString(),
      });
    } else if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_TOTP_CODE") {
      setCode("");
      setStage({ step: "totp-code" });
    } else if (nextStep.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      // Every admin account is provisioned via admin-create-user (self-signup is
      // disabled), which always issues a temporary password -- so this challenge fires on
      // literally every account's first sign-in, not an edge case.
      setStage({ step: "new-password" });
    } else {
      // Other challenge types (SMS, custom) aren't issued by this user pool's current
      // config -- surfaced as a message rather than silently stuck.
      setError(`未対応の追加認証手順です: ${nextStep.signInStep}`);
    }
  }

  async function onSubmitCredentials(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      ensureAmplifyConfigured();
      let result;
      try {
        result = await signIn({ username: email, password });
      } catch (err) {
        // Amplify caches a session in the browser across visits; if a previous sign-in
        // was never explicitly logged out (session left open in another tab, a stale
        // cached session from before), signIn() refuses to start a new one and throws
        // this instead of just replacing it. Signing out that stale session first and
        // retrying is exactly what the operator entering fresh credentials here wants.
        if ((err as Error).name === "UserAlreadyAuthenticatedException") {
          await signOut();
          result = await signIn({ username: email, password });
        } else {
          throw err;
        }
      }
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

  async function onSubmitNewPassword(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
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

  async function submitCode(value: string) {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await confirmSignIn({ challengeResponse: value });
      if (result.isSignedIn) {
        router.replace("/dashboard");
      } else {
        handleNextStep(result.nextStep);
      }
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  if (stage.step === "new-password") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>新しいパスワードの設定</h1>
          <p style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>
            初回ログインのため、新しいパスワードを設定してください(12文字以上、大文字・小文字・数字・記号を含む)。
          </p>
          <form onSubmit={onSubmitNewPassword} style={{ marginTop: "1.25rem" }}>
            <PasswordField label="新しいパスワード" value={newPassword} onChange={setNewPassword} autoFocus minLength={12} />
            {error && <p className="auth-error">{error}</p>}
            <button type="submit" disabled={submitting} style={{ width: "100%" }}>
              {submitting ? "設定中..." : "パスワードを設定してサインイン"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (stage.step === "totp-setup" || stage.step === "totp-code") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <Brand />
          <h1>2段階認証</h1>
          {stage.step === "totp-setup" ? (
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
          ) : (
            <p style={{ marginTop: "0.75rem", fontSize: "0.85rem", color: "var(--fg-muted)" }}>認証アプリの6桁のコードを入力してください。</p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitCode(code);
            }}
            style={{ marginTop: "1.25rem" }}
          >
            <OtpInput value={code} onChange={setCode} onComplete={submitCode} disabled={submitting} />
            {error && (
              <p className="auth-error" style={{ marginTop: "1rem" }}>
                {error}
              </p>
            )}
            <button type="submit" disabled={submitting || code.length !== 6} style={{ width: "100%", marginTop: "1.1rem" }}>
              {submitting ? "確認中..." : "確認してサインイン"}
            </button>
          </form>

          <div className="auth-callout warn">
            <ShieldIcon />
            <span>コードを他人に共有しないでください。第三者に教えると、アカウントが不正に利用されるおそれがあります。</span>
          </div>

          <div style={{ marginTop: "1rem", textAlign: "center" }}>
            <button
              type="button"
              onClick={() => setShowMfaHelp((v) => !v)}
              style={{ background: "none", border: "none", color: "var(--accent)", fontSize: "0.8rem", cursor: "pointer", padding: 0 }}
            >
              認証アプリを使えない場合
            </button>
            {showMfaHelp && (
              <p style={{ marginTop: "0.6rem", fontSize: "0.78rem", color: "var(--fg-subtle)", lineHeight: 1.6, textAlign: "left" }}>
                認証アプリ・デバイスを紛失した場合、ご自身での再設定はできません。管理者による本人確認のうえでの復旧対応が必要です。導入時のご連絡先までお問い合わせください。
              </p>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <Brand />
        <p className="auth-tagline">国内と海外の販売を、ひとつに。</p>
        <h1>ログイン</h1>
        <form onSubmit={onSubmitCredentials} style={{ marginTop: "1.25rem" }}>
          <div className="auth-field">
            <label>
              メールアドレス
              <input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          </div>
          <PasswordField label="パスワード" value={password} onChange={setPassword} />
          <div className="auth-links-row">
            <Link href="/forgot-password">パスワードを忘れた方</Link>
          </div>
          {error && <p className="auth-error">{error}</p>}
          <button type="submit" disabled={submitting} style={{ width: "100%" }}>
            {submitting ? "サインイン中..." : "ログイン"}
          </button>
        </form>

        <div className="auth-divider">または</div>
        <Link href="/signup" className="auth-secondary-action">
          招待コードをお持ちの方 新規登録
        </Link>

        <div className="auth-callout">
          <ShieldIcon />
          <span>ログイン後に2段階認証を行います。大切なアカウントを守るため、セキュリティを強化しています。</span>
        </div>
      </div>
    </div>
  );
}
