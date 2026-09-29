import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  lead?: string;
  actions?: ReactNode;
}

/** Formalizes the `.page-header`/`.page-lead` markup pattern every page already hand-rolls
 *  (dashboard, products, orders, ...) into one component, so it stays visually consistent
 *  as more pages are redesigned. */
export function PageHeader({ title, lead, actions }: PageHeaderProps) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

interface SectionHeaderProps {
  title: string;
  action?: ReactNode;
}

/** The "card title + a single right-aligned link/action" row repeated across every
 *  dashboard/detail card (同期ステータス, 最近のアクティビティ, 重要なお知らせ, ...). */
export function SectionHeader({ title, action }: SectionHeaderProps) {
  return (
    <div className="section-header">
      <h2>{title}</h2>
      {action && <div className="section-header-action">{action}</div>}
    </div>
  );
}
