"use client";

import { fetchUserAttributes, signOut } from "aws-amplify/auth";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";

const LINKS = [
  { href: "/dashboard", label: "ダッシュボード" },
  { href: "/products", label: "商品" },
  { href: "/commerce", label: "コマース統合ビュー" },
  { href: "/sync-errors", label: "同期エラー" },
  { href: "/audit-log", label: "監査ログ" },
];

export function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // next.config.mjs's trailingSlash:true means the real route is "/login/", not "/login" --
  // an exact-match check without normalizing this let the nav bar (and its logout button)
  // render on top of the unauthenticated login screen in every real deploy.
  const isLoginPage = pathname?.replace(/\/$/, "") === "/login";

  useEffect(() => {
    if (isLoginPage) return;
    ensureAmplifyConfigured();
    fetchUserAttributes()
      .then((attrs) => setEmail(attrs.email ?? null))
      .catch(() => setEmail(null));
  }, [isLoginPage]);

  if (isLoginPage) return null;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      router.replace("/login");
    }
  }

  return (
    <header className="app-header">
      <Link href="/dashboard" className="app-brand">
        <span className="app-brand-mark">AI</span>
        AI EC運営プラットフォーム
      </Link>
      <nav className="app-nav">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} data-active={pathname?.startsWith(link.href) || undefined}>
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="app-user">
        {email && <span className="app-user-email">{email}</span>}
        <button type="button" className="ghost" onClick={handleSignOut} disabled={signingOut}>
          {signingOut ? "サインアウト中..." : "ログアウト"}
        </button>
      </div>
    </header>
  );
}
