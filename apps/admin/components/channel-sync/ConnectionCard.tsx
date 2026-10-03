import Link from "next/link";
import { relativeTime } from "@/lib/format";
import { CHANNEL_META, type DisplayedChannel } from "@/lib/channel-meta";
import { RefreshIcon } from "@/components/icons";
import { StatusBadge } from "@/components/ui/Badge";
import { DropdownMenu } from "@/components/ui/DropdownMenu";
import type { ConnectionDetail } from "./types";

interface ConnectionCardProps {
  channel: DisplayedChannel;
  detail: ConnectionDetail | null;
  loading: boolean;
  onCheck: () => void;
  onReconnect: () => void;
  checking: boolean;
}

/** "あと58日" style countdown -- negative (already expired) shown separately, since a plain
 *  negative day count ("あと-3日") reads as a bug, not an expired token. */
function expiresAtLabel(expiresAt: string | null): string {
  if (!expiresAt) return "未接続";
  const days = Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000));
  const absolute = new Date(expiresAt).toLocaleString("ja-JP");
  if (days < 0) return `期限切れ(${absolute})`;
  return `${absolute}(あと${days}日)`;
}

export function ConnectionCard({ channel, detail, loading, onCheck, onReconnect, checking }: ConnectionCardProps) {
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
              <span className={`badge ${detail.connected ? "ok" : "error"}`}>{detail.connected ? "有効" : "未接続"}</span>
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
          <div>
            <dt>同期ステータス</dt>
            <dd>{detail.state === "HEALTHY" ? "正常に同期されています" : (detail.reasons[0] ?? detail.state)}</dd>
          </div>
        </dl>
      )}

      <div className="connection-card-actions">
        <button type="button" className="secondary" onClick={onCheck} disabled={checking}>
          <RefreshIcon /> 接続確認
        </button>
        <button type="button" className="secondary" onClick={onReconnect}>
          再接続
        </button>
        <DropdownMenu label={`${meta.title}の詳細メニュー`} trigger={<span aria-hidden="true">⋯</span>}>
          <Link href="/audit-log" className="dropdown-menu-item">
            監査ログを見る
          </Link>
        </DropdownMenu>
      </div>
    </div>
  );
}
