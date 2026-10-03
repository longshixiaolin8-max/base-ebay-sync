import { useState } from "react";
import { EmptyState } from "@/components/Skeleton";
import type { SyncTraceEntry } from "./types";

const SOURCE_LABEL: Record<SyncTraceEntry["source"], string> = {
  inventory_event: "在庫イベント",
  audit_log: "操作ログ",
  sync_error: "同期エラー",
};

/**
 * Generic over traceSyncHistory's 3-source union (inventory_event/audit_log/sync_error) --
 * no existing component covered this; the closest precedent (drafts/DraftHistoryPanel.tsx) is
 * narrowly typed to AuditLogEntry[] only. Each entry's real `detail` payload is shown via an
 * inline toggle rather than distinct per-source action buttons/links (注文を確認 etc. in the
 * design image), since a reliable real navigation target isn't available for every source --
 * showing the actual recorded detail is honest or an invented link isn't.
 */
export function EventTimeline({ entries }: { entries: SyncTraceEntry[] }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (entries.length === 0) return <EmptyState>記録がありません。</EmptyState>;

  return (
    <ul className="event-timeline">
      {entries.map((entry, i) => (
        <li key={i} className="event-timeline-item">
          <div className="event-timeline-head">
            <span className={`badge ${entry.source === "sync_error" ? "error" : "neutral"}`}>{SOURCE_LABEL[entry.source]}</span>
            <span className="event-timeline-time">{new Date(entry.occurredAt).toLocaleString("ja-JP")}</span>
          </div>
          <div className="event-timeline-summary">{entry.summary}</div>
          {Object.keys(entry.detail ?? {}).length > 0 && (
            <>
              <button type="button" className="ghost event-timeline-toggle" onClick={() => setOpenIndex(openIndex === i ? null : i)}>
                {openIndex === i ? "詳細を閉じる" : "詳細を見る"}
              </button>
              {openIndex === i && <pre className="event-timeline-detail">{JSON.stringify(entry.detail, null, 2)}</pre>}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
