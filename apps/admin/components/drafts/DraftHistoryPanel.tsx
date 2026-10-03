import type { AuditLogEntry } from "@ai-ec/core";
import { AUDIT_ACTION_LABEL } from "@/lib/audit-action-copy";
import { EmptyState } from "@/components/Skeleton";

const dateFormatter = new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** Real history, not a placeholder timeline: GET /admin/audit-log already records every one
 *  of these actions -- this just filters that same log to the entries relevant to the
 *  currently-selected product/draft (recordAuditLog logs some actions against entityType
 *  "product" and others against "ai_listing_draft", so both ids are checked). */
export function DraftHistoryPanel({ entries, productId, draftId }: { entries: AuditLogEntry[]; productId: string; draftId: string }) {
  const relevant = entries
    .filter(
      (e) =>
        (e.entityType === "product" && e.entityId === productId) || (e.entityType === "ai_listing_draft" && e.entityId === draftId),
    )
    .slice(0, 10);

  if (relevant.length === 0) {
    return <EmptyState>まだ履歴がありません。</EmptyState>;
  }

  return (
    <ul className="draft-history">
      {relevant.map((e) => (
        <li key={e.id} className="draft-history-item">
          <span className="draft-history-actor">{e.actor.startsWith("system:") ? "AI" : e.actor}</span>
          <span className="draft-history-text">{AUDIT_ACTION_LABEL[e.action] ?? e.action}</span>
          <span className="draft-history-time">{dateFormatter.format(new Date(e.createdAt))}</span>
        </li>
      ))}
    </ul>
  );
}
