"use client";

import { useCallback, useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { relativeTime } from "@/lib/format";
import { useToast } from "@/components/Toast";
import { Card } from "@/components/ui/Card";
import { StatusBadge, Badge } from "@/components/ui/Badge";
import { BoxIcon, TagIcon, PlugIcon } from "@/components/icons";
import type { ConnectionDetailLite, ConnectionsResponseLite } from "./types";

const CHANNEL_META = {
  base: { icon: BoxIcon, title: "BASE", subtitle: "自社ストア" },
  ebay: { icon: TagIcon, title: "eBay", subtitle: "海外マーケット" },
} as const;

function expiresAtLabel(expiresAt: string | null): string {
  if (!expiresAt) return "未接続";
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const absolute = new Date(expiresAt).toLocaleString("ja-JP");
  if (days < 0) return `期限切れ(${absolute})`;
  return `${absolute}(あと${days}日)`;
}

function ConnectionRow({
  channel,
  detail,
  loading,
  onCheck,
  onReconnect,
  onDisconnect,
  checking,
  disconnecting,
}: {
  channel: "base" | "ebay";
  detail: ConnectionDetailLite | null;
  loading: boolean;
  onCheck: () => void;
  onReconnect: () => void;
  onDisconnect: () => void;
  checking: boolean;
  disconnecting: boolean;
}) {
  const meta = CHANNEL_META[channel];
  const Icon = meta.icon;
  return (
    <div className="connection-card">
      <div className="connection-card-head">
        <div className="connection-card-title">
          <Icon width={20} height={20} />
          <div>
            <h3>{meta.title}</h3>
            <span className="connection-card-subtitle">{meta.subtitle}</span>
          </div>
        </div>
        {detail && <StatusBadge state={detail.state} />}
      </div>

      {loading || !detail ? (
        <div className="connection-card-loading">確認中...</div>
      ) : (
        <dl className="connection-card-rows">
          <div>
            <dt>OAuth認証</dt>
            <dd>
              <Badge tone={detail.connected ? "ok" : "error"}>{detail.connected ? "有効" : "未接続"}</Badge>
            </dd>
          </div>
          <div>
            <dt>トークン有効期限</dt>
            <dd>{expiresAtLabel(detail.expiresAt)}</dd>
          </div>
          <div>
            <dt>最終同期時刻</dt>
            <dd>{detail.lastSyncedAt ? relativeTime(detail.lastSyncedAt) : "同期履歴なし"}</dd>
          </div>
        </dl>
      )}

      <div className="connection-card-actions">
        <button type="button" className="secondary" onClick={onCheck} disabled={checking}>
          接続確認
        </button>
        <button type="button" className="secondary" onClick={onReconnect}>
          再接続
        </button>
        {detail?.connected && (
          <button type="button" className="secondary" style={{ color: "var(--danger)" }} onClick={onDisconnect} disabled={disconnecting}>
            {disconnecting ? "解除中..." : "接続解除"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ConnectionsTab() {
  const { notify } = useToast();
  const [connections, setConnections] = useState<ConnectionsResponseLite | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [disconnecting, setDisconnecting] = useState<"base" | "ebay" | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<"base" | "ebay" | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiGet<ConnectionsResponseLite>("/admin/sync/connections");
      setConnections(res);
    } catch (err) {
      notify(`接続状況の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
      setChecking(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, []);

  async function handleReconnect(channel: "base" | "ebay") {
    try {
      const res = await apiGet<{ url: string }>(`/admin/oauth/${channel}/authorize-url`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      notify(`再接続用リンクの取得に失敗しました: ${(err as Error).message}`);
    }
  }

  async function handleDisconnect(channel: "base" | "ebay") {
    setDisconnecting(channel);
    try {
      await apiPost(`/admin/oauth/${channel}/disconnect`);
      notify(`${CHANNEL_META[channel].title}の接続を解除しました。`, "success");
      setConfirmDisconnect(null);
      await load();
    } catch (err) {
      notify(`接続解除に失敗しました: ${(err as Error).message}`);
    } finally {
      setDisconnecting(null);
    }
  }

  return (
    <div>
      <div className="channel-sync-connections">
        <ConnectionRow
          channel="base"
          detail={connections?.base ?? null}
          loading={loading}
          checking={checking}
          disconnecting={disconnecting === "base"}
          onCheck={() => {
            setChecking(true);
            void load();
          }}
          onReconnect={() => handleReconnect("base")}
          onDisconnect={() => setConfirmDisconnect("base")}
        />
        <ConnectionRow
          channel="ebay"
          detail={connections?.ebay ?? null}
          loading={loading}
          checking={checking}
          disconnecting={disconnecting === "ebay"}
          onCheck={() => {
            setChecking(true);
            void load();
          }}
          onReconnect={() => handleReconnect("ebay")}
          onDisconnect={() => setConfirmDisconnect("ebay")}
        />
      </div>

      {confirmDisconnect && (
        <Card style={{ marginTop: "1.25rem", maxWidth: 480 }}>
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
            {CHANNEL_META[confirmDisconnect].title}
            の接続を解除すると、以降の同期・出品操作が行えなくなります。よろしいですか？
          </p>
          <div style={{ display: "flex", gap: "0.6rem" }}>
            <button type="button" className="secondary" onClick={() => setConfirmDisconnect(null)} style={{ flex: 1 }}>
              やめる
            </button>
            <button
              type="button"
              onClick={() => handleDisconnect(confirmDisconnect)}
              disabled={disconnecting !== null}
              style={{ flex: 1, background: "var(--danger)" }}
            >
              接続を解除する
            </button>
          </div>
        </Card>
      )}

      <Card style={{ marginTop: "1.25rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
          <PlugIcon width={18} height={18} />
          <h2 style={{ fontSize: "0.95rem", margin: 0 }}>外部サービスを追加</h2>
        </div>
        <p className="settings-disabled-note">
          このプラットフォームが対応する外部サービスは現在BASE・eBayの2つのみです。他サービスとの連携は未提供のため、追加ボタンは無効化しています。
        </p>
        <button type="button" className="secondary" disabled style={{ marginTop: "0.75rem" }}>
          外部サービスを追加(未提供)
        </button>
      </Card>
    </div>
  );
}
