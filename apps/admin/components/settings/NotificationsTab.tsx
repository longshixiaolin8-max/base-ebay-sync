"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPatch } from "@/lib/api-client";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Switch } from "@/components/ui/Switch";
import type { NotificationPreferences } from "./types";

/** `delivered: true` means a real trigger + email-send path exists in the backend today
 *  (see services/lambdas/stripe-webhook's billing-notice emails via SES) -- not just that
 *  the toggle is saved. The other four keys are saved and read back correctly, but nothing
 *  in this codebase yet calls sendEmail() for them: inventoryDiffAlert/aiDraftCompleted have
 *  no wired trigger in their respective workers, oauthExpiryNotice has no periodic expiry
 *  check, and importantNotice has no operator-broadcast mechanism at all yet. */
const NOTIFICATION_META: { key: keyof NotificationPreferences; label: string; description: string; delivered: boolean }[] = [
  { key: "inventoryDiffAlert", label: "在庫差異アラート", description: "BASE/eBay間で在庫数に差異が検知されたとき", delivered: false },
  { key: "aiDraftCompleted", label: "AI下書き生成完了", description: "AIが出品ドラフトの生成を完了したとき", delivered: false },
  { key: "billingNotice", label: "請求関連のお知らせ", description: "支払い失敗・契約解約など請求状況の変化があったとき", delivered: true },
  { key: "oauthExpiryNotice", label: "外部アカウントの有効期限通知", description: "BASE/eBayのOAuthトークンが失効間近になったとき", delivered: false },
  { key: "importantNotice", label: "重要なお知らせ", description: "メンテナンス・障害など運営からの重要な連絡", delivered: false },
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
        「請求関連のお知らせ」は実際にメール配信されます(送信元アドレスが未設定の環境では送信自体がスキップされます)。それ以外の項目は設定の保存・復元のみ行われ、通知の配信基盤は未実装です(今後の実装のためのTODOです)。
      </p>
      <div style={{ marginTop: "0.5rem" }}>
        {NOTIFICATION_META.map(({ key, label, description, delivered }) => (
          <div key={key} className="settings-row">
            <div className="settings-row-text">
              <strong>
                {label} <Badge tone={delivered ? "ok" : "neutral"}>{delivered ? "配信対応済み" : "保存のみ"}</Badge>
              </strong>
              <span>{description}</span>
            </div>
            <Switch checked={prefs[key]} onChange={(next) => toggle(key, next)} label={label} disabled={savingKey === key} />
          </div>
        ))}
      </div>
    </Card>
  );
}
