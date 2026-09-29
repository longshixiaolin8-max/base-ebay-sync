import Link from "next/link";
import { EmptyState } from "@/components/Skeleton";
import { Badge, PriorityBadge, type BadgeTone, type TaskPriority } from "@/components/ui/Badge";

export interface DashboardTask {
  id: string;
  typeLabel: string;
  typeTone: BadgeTone;
  title: string;
  sku?: string | null;
  detail: string;
  priority: TaskPriority;
  statusLabel: string;
  statusTone: BadgeTone;
  createdAt: string;
  actionLabel: string;
  actionHref: string;
}

const dateFormatter = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

/** The image's "対応が必要なタスク" table -- composed by the dashboard page from real
 *  sync-errors + ai_generated products, not a separate invented "tasks" API. */
export function TaskTable({ tasks }: { tasks: DashboardTask[] }) {
  if (tasks.length === 0) {
    return <EmptyState>対応が必要なタスクはありません。</EmptyState>;
  }
  return (
    <div className="table-wrapper">
      <table>
        <thead>
          <tr>
            <th>種別</th>
            <th>商品</th>
            <th>内容</th>
            <th>優先度</th>
            <th>状態</th>
            <th>発生日時</th>
            <th aria-label="アクション" />
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <Badge tone={t.typeTone}>{t.typeLabel}</Badge>
              </td>
              <td>
                {t.title}
                {t.sku && <div style={{ fontSize: "0.75rem", color: "var(--fg-subtle)" }}>SKU: {t.sku}</div>}
              </td>
              <td>{t.detail}</td>
              <td>
                <PriorityBadge priority={t.priority} />
              </td>
              <td>
                <Badge tone={t.statusTone}>{t.statusLabel}</Badge>
              </td>
              <td style={{ whiteSpace: "nowrap", color: "var(--fg-subtle)", fontSize: "0.8rem" }}>
                {dateFormatter.format(new Date(t.createdAt))}
              </td>
              <td>
                <Link href={t.actionHref} className="secondary" style={{ padding: "0.35rem 0.6rem", fontSize: "0.78rem" }}>
                  {t.actionLabel}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
