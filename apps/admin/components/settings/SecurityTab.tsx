"use client";

import { fetchMFAPreference, updatePassword } from "aws-amplify/auth";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { ShieldIcon } from "@/components/icons";

export default function SecurityTab() {
  const { notify } = useToast();
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);

  useEffect(() => {
    fetchMFAPreference()
      .then((res) => setMfaEnabled((res.enabled ?? []).includes("TOTP")))
      .catch(() => setMfaEnabled(null));
  }, []);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("新しいパスワードが一致しません。");
      return;
    }
    setChanging(true);
    try {
      await updatePassword({ oldPassword, newPassword });
      notify("パスワードを変更しました。", "success");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="settings-grid">
      <Card>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.75rem" }}>パスワード変更</h2>
        <form onSubmit={handleChangePassword}>
          {error && <div className="auth-error">{error}</div>}
          <label className="settings-field">
            現在のパスワード
            <input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} required autoComplete="current-password" />
          </label>
          <label className="settings-field">
            新しいパスワード
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoComplete="new-password" minLength={8} />
          </label>
          <label className="settings-field">
            新しいパスワード(確認)
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
            />
          </label>
          <div className="settings-form-actions">
            <button type="submit" disabled={changing}>
              {changing ? "変更中..." : "パスワードを変更"}
            </button>
          </div>
        </form>
      </Card>

      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <ShieldIcon width={18} height={18} />
          <h2 style={{ fontSize: "0.95rem", margin: 0 }}>多要素認証(MFA)</h2>
        </div>
        <div className="settings-row" style={{ marginTop: "0.5rem" }}>
          <div className="settings-row-text">
            <strong>認証アプリ(TOTP)</strong>
            <span>初回サインイン時に設定が必須です。</span>
          </div>
          <Badge tone={mfaEnabled === null ? "neutral" : mfaEnabled ? "ok" : "error"}>
            {mfaEnabled === null ? "確認中..." : mfaEnabled ? "有効" : "未設定"}
          </Badge>
        </div>
        <p className="settings-disabled-note">
          認証アプリの再設定・無効化はセルフサービスでは行えません。認証アプリやデバイスを紛失した場合は、管理者による本人確認のうえでの復旧対応が必要です。
        </p>
      </Card>

      <Card>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>APIキー</h2>
        <p className="settings-disabled-note">
          テナント向けのAPIキー発行機能は現在ご提供していません。外部システムとの連携が必要な場合はサポートまでお問い合わせください。
        </p>
        <button type="button" className="secondary" disabled style={{ marginTop: "0.5rem" }}>
          APIキーを発行(未提供)
        </button>
      </Card>

      <Card>
        <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>操作履歴</h2>
        <p style={{ fontSize: "0.85rem", margin: "0 0 0.75rem" }}>アカウント・接続設定・価格設定などの変更はすべて監査ログに記録されています。</p>
        <Link href="/audit-log" className="secondary" style={{ display: "inline-block", padding: "0.5rem 1rem", borderRadius: "var(--radius-sm)" }}>
          監査ログを見る
        </Link>
      </Card>
    </div>
  );
}
