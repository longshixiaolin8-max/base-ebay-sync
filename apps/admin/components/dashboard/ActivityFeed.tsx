import type { AuditLogEntry } from "@ai-ec/core";
import { AUDIT_ACTION_LABEL } from "@/lib/audit-action-copy";
import { relativeTime } from "@/lib/format";
import { EmptyState } from "@/components/Skeleton";

/** The image's "最近のアクティビティ" feed, straight off GET /admin/audit-log (already
 *  records every action this platform takes -- no separate "activity" concept invented). */
export function ActivityFeed({ entries }: { entries: AuditLogEntry[] }) {
  if (entries.length === 0) {
    return <EmptyState>まだ記録がありません。</EmptyState>;
  }
  return (
    <ul className="activity-feed">
      {entries.map((e) => (
        <li key={e.id} className="activity-feed-item">
          <span className="activity-feed-time">{relativeTime(e.createdAt)}</span>
          <span className="activity-feed-text">{AUDIT_ACTION_LABEL[e.action] ?? e.action}</span>
        </li>
      ))}
    </ul>
  );
}
