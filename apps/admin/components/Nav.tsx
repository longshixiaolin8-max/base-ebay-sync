"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/products", label: "商品" },
  { href: "/commerce", label: "コマース統合ビュー" },
  { href: "/sync-errors", label: "同期エラー" },
  { href: "/audit-log", label: "監査ログ" },
];

export function Nav() {
  const pathname = usePathname();
  if (pathname === "/login") return null;

  return (
    <nav>
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href} style={{ fontWeight: pathname?.startsWith(link.href) ? 700 : 500 }}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
