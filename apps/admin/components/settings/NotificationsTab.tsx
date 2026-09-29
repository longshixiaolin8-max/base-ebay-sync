"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api-client";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import { Switch } from "@/components/ui/Switch";
import type { NotificationPreferences } from "./types";

const NOTIFICATION_META: { key: keyof NotificationPreferences; label: string; description: string }[] = [
  { key: "inventoryDiffAlert", label: "在庫差異アラート", description: "BASE/eBay間で在庫数に差異が検知されたとき" },
  { key: "aiDraftCompleted", label: "AI下書き生成完了", description: "AIが出品ドラフトの生成を完了したとき" },
  { key: "billingNotice", label: "請求関連のお知らせ", description: "支払い失敗・契約更新など請求状況の変化があったとき" },
  { key: "oauthExpiryNotice", label: "外部アカウントの有効期限通知", description: "BASE/eBayのOAuthトークンが失効間近になったとき" },
  { key: "importantNotice", label: "重要なお知らせ", description: "メンテナンス・障害など運営からの重要な連絡" },
];

export default function NotificationsTab() {
  const { notify } = useToast();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  useEffect(() => {
    apiGet<NotificationPreferences>("/admin/tenant/notification-preferences")
      .then(setPrefs)
      .catch((err) => notify(`通知設定の取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, []);

  async function toggle(key: keyof NotificationPreferences, next: boolean) {
    if (!prefs) return;
    const prev = prefs;
    setPrefs({ ...prefs, [key]: next });
    setSavingKey(key);
    try {
      const updated = await apiPatch<NotificationPreferences>("/admin/tenant/notification-preferences", { [key]: next });
      setPrefs(updated);
    } catch (err) {
      setPrefs(prev);
      notify(`通知設定の更新に失敗しました: ${(err as Error).message}`);
    } finally {
      setSavingKey(null);
    }
  }

  if (loading) return <div className="card card-pad">読み込み中...</div>;
  if (!prefs) return null;

  return (
    <Card style={{ maxWidth: 640 }}>
      <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>通知設定</h2>
      <p className="settings-disabled-note">
        現在このプラットフォームにはメール等の通知配信基盤が実装されていません。ここでの設定は保存・復元されますが、通知が実際に配信されることはまだありません(今後の実装のためのTODOです)。
      </p>
      <div style={{ marginTop: "0.5rem" }}>
        {NOTIFICATION_META.map(({ key, label, description }) => (
          <div key={key} className="settings-row">
            <div className="settings-row-text">
              <strong>{label}</strong>
              <span>{description}</span>
            </div>
            <Switch checked={prefs[key]} onChange={(next) => toggle(key, next)} label={label} disabled={savingKey === key} />
          </div>
        ))}
      </div>
    </Card>
  );
}
