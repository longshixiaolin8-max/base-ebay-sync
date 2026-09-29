import Link from "next/link";
import type { ComponentType, SVGProps } from "react";

export interface QuickAction {
  id: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: string;
  desc: string;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
}

export function QuickActions({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="quick-action-grid">
      {actions.map((a) => {
        const Icon = a.icon;
        const content = (
          <>
            <span className="quick-action-icon">
              <Icon width={18} height={18} />
            </span>
            <span className="quick-action-body">
              <span className="quick-action-title">{a.title}</span>
              <span className="quick-action-desc">{a.desc}</span>
            </span>
          </>
        );
        const className = `quick-action-card${a.primary ? " primary" : ""}`;
        return a.href ? (
          <Link key={a.id} href={a.href} className={className}>
            {content}
          </Link>
        ) : (
          <button key={a.id} type="button" className={className} onClick={a.onClick}>
            {content}
          </button>
        );
      })}
    </div>
  );
}
