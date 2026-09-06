"use client";

import { confirmSignIn, signIn } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";

type Stage =
  | { step: "credentials" }
  | { step: "totp-setup"; sharedSecret: string; setupUri: string }
  | { step: "totp-code" };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<Stage>({ step: "credentials" });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
      <div style={{ maxWidth: 360, margin: "4rem auto" }}>
        <h1>認証アプリの確認コード</h1>
        {stage.step === "totp-setup" && (
          <div style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
            <p>初回ログインです。認証アプリ(Google Authenticator等)でこのシークレットキーを登録してください:</p>
            <code style={{ display: "block", padding: "0.5rem", background: "#f0f0f0", wordBreak: "break-all" }}>
              {stage.sharedSecret}
            </code>
          </div>
        )}
        <form onSubmit={onSubmitCode} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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
              style={{ width: "100%", padding: "0.5rem" }}
            />
          </label>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "確認中..." : "確認してサインイン"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 360, margin: "4rem auto" }}>
      <h1>管理者ログイン</h1>
      <form onSubmit={onSubmitCredentials} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        <label>
          メールアドレス
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ width: "100%", padding: "0.5rem" }}
          />
        </label>
        <label>
          パスワード
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: "100%", padding: "0.5rem" }}
          />
        </label>
        {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
        <button type="submit" disabled={submitting}>
          {submitting ? "サインイン中..." : "サインイン"}
        </button>
      </form>
      <p style={{ fontSize: "0.8rem", color: "#666", marginTop: "1rem" }}>
        アカウントは管理者が事前に発行します(セルフサインアップ不可)。このユーザープールは認証アプリによる確認コードの入力が必須です。
      </p>
    </div>
  );
}
