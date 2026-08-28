"use client";

import { signIn } from "aws-amplify/auth";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      ensureAmplifyConfigured();
      const result = await signIn({ username: email, password });
      if (result.isSignedIn) {
        router.replace("/dashboard");
      } else {
        // e.g. NEW_PASSWORD_REQUIRED / MFA challenge — handled by Cognito Hosted UI
        // in a fuller implementation; surfaced here as a next-step message for now.
        setError(`追加の認証手順が必要です: ${result.nextStep.signInStep}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "4rem auto" }}>
      <h1>管理者ログイン</h1>
      <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
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
        アカウントは管理者が事前に発行します(セルフサインアップ不可)。MFAが有効な場合は続けて確認コードの入力が必要です。
      </p>
    </div>
  );
}
