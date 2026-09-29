import Link from "next/link";
import type { ComponentType, ReactNode, SVGProps } from "react";

export type KpiColor = "blue" | "orange" | "green" | "purple" | "red";

interface KpiCardProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  color: KpiColor;
  value: ReactNode;
  label: string;
  sub?: ReactNode;
  href?: string;
}

/** Generalizes the KPI-card markup dashboard/page.tsx used to hand-roll inline (icon chip +
 *  big value + label + a small sub-line for trend/status) into one reusable component, on
 *  top of the existing `.kpi-card`/`.kpi-value`/... classes in globals.css. */
export function KpiCard({ icon: Icon, color, value, label, sub, href }: KpiCardProps) {
  const body = (
    <>
      <span className={`stat-card-icon ${color}`}>
        <Icon width={18} height={18} />
      </span>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="kpi-card kpi-card-link">
        {body}
      </Link>
    );
  }
  return <div className="kpi-card">{body}</div>;
}
