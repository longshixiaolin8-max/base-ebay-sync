import Link from "next/link";
import { AlertIcon } from "@/components/icons";

export interface DashboardAlert {
  id: string;
  tone: "error" | "warn";
  title: string;
  description: string;
  actionLabel: string;
  actionHref?: string;
  onAction?: () => void;
  timestamp?: string;
}

/** The image's "重要なお知らせ" panel -- every alert this renders is built by the dashboard
 *  page from real signals (see buildDashboardAlerts there), never placeholder content. */
export function AlertsPanel({ alerts }: { alerts: DashboardAlert[] }) {
  if (alerts.length === 0) {
    return <div className="empty-state">現在、確認が必要な項目はありません。</div>;
  }
  return (
    <div className="alert-banner-list">
      {alerts.map((a) => (
        <div key={a.id} className={`alert-banner ${a.tone}`}>
          <span className="alert-banner-icon">
            <AlertIcon width={16} height={16} />
          </span>
          <div className="alert-banner-body">
            <div className="alert-banner-title-row">
              <span className="alert-banner-title">{a.title}</span>
              {a.timestamp && <span className="alert-banner-time">{a.timestamp}</span>}
            </div>
            <div className="alert-banner-desc">{a.description}</div>
            {a.actionHref ? (
              <Link href={a.actionHref} className="secondary alert-banner-action">
                {a.actionLabel}
              </Link>
            ) : (
              <button type="button" className="secondary alert-banner-action" onClick={a.onAction}>
                {a.actionLabel}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
