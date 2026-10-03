"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMobileNav } from "@/components/MobileNav";
import { BoxIcon, CartIcon, DashboardIcon, MoreIcon, ShieldIcon } from "@/components/icons";

const PRIMARY_LINKS = [
  { href: "/dashboard", label: "ホーム", icon: DashboardIcon },
  { href: "/products", label: "商品", icon: BoxIcon },
  { href: "/inventory", label: "在庫", icon: ShieldIcon },
  { href: "/orders", label: "注文", icon: CartIcon },
] as const;

const PUBLIC_PATHS = new Set(["", "/login", "/signup", "/forgot-password", "/terms", "/privacy", "/legal", "/support"]);

/**
 * Mobile-first primary navigation. The existing sidebar remains the complete navigation
 * surface and is opened from "その他", while the four highest-frequency operational
 * destinations stay one tap away.
 */
export function MobileBottomNav() {
  const pathname = usePathname();
  const { toggle } = useMobileNav();
  const normalizedPath = pathname?.replace(/\/$/, "") ?? "";

  if (PUBLIC_PATHS.has(normalizedPath)) return null;

  return (
    <nav className="mobile-bottom-nav" aria-label="主要ナビゲーション">
      {PRIMARY_LINKS.map((item) => {
        const Icon = item.icon;
        const active = normalizedPath === item.href || normalizedPath.startsWith(`${item.href}/`);
        return (
          <Link key={item.href} href={item.href} className="mobile-bottom-nav-item" data-active={active || undefined}>
            <Icon aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
      <button
        type="button"
        className="mobile-bottom-nav-item mobile-bottom-nav-more"
        onClick={toggle}
        aria-label="その他の機能を開く"
      >
        <MoreIcon aria-hidden="true" />
        <span>その他</span>
      </button>
    </nav>
  );
}
