"use client";

import type { SyncError } from "@ai-ec/core";
import { fetchUserAttributes, signOut } from "aws-amplify/auth";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { apiGet } from "@/lib/api-client";
import { useMobileNav } from "@/components/MobileNav";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ActivityIcon, AlertIcon, BoxIcon, CartIcon, CoinIcon, DashboardIcon, FileIcon, PlugIcon, SyncIcon } from "@/components/icons";

const LINKS = [
  { href: "/dashboard", label: "ダッシュボード", icon: DashboardIcon },
  { href: "/onboarding", label: "導入設定", icon: PlugIcon },
  { href: "/products", label: "商品マスター", icon: BoxIcon },
  { href: "/commerce", label: "コマース統合", icon: SyncIcon },
  { href: "/orders", label: "注文管理", icon: CartIcon },
  { href: "/sync-errors", label: "同期エラー", icon: AlertIcon },
  { href: "/system-health", label: "システム状態", icon: ActivityIcon },
  { href: "/audit-log", label: "監査ログ", icon: FileIcon },
  { href: "/billing", label: "請求", icon: CoinIcon },
];

interface ChannelState {
  state: "HEALTHY" | "DEGRADED" | "ISOLATED" | "RECOVERING" | "RECONCILING";
}

function statusDotClass(state?: ChannelState["state"]): string {
  if (state === "HEALTHY") return "ok";
  if (state === "ISOLATED" || state === "RECONCILING") return "error";
  return "warn"; // DEGRADED / RECOVERING, or unknown while still loading
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { open, close } = useMobileNav();
  const [email, setEmail] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [errorCount, setErrorCount] = useState(0);
  const [baseState, setBaseState] = useState<ChannelState | null>(null);
  const [ebayState, setEbayState] = useState<ChannelState | null>(null);
  // next.config.mjs's trailingSlash:true means the real route is "/login/", not "/login" --
  // an exact-match check without normalizing this let the sidebar (and its logout button)
  // render on top of the unauthenticated login screen in every real deploy. /signup is the
  // other public, unauthenticated page (Phase 2's self-service signup flow); "" is the root
  // "/" itself, now the public landing page (Phase 4) rather than a redirect to /dashboard.
  const normalizedPath = pathname?.replace(/\/$/, "");
  const isPublicPage =
    normalizedPath === "" ||
    normalizedPath === "/login" ||
    normalizedPath === "/signup" ||
    normalizedPath === "/forgot-password";

  // Tapping a nav link should close the drawer on mobile, same as tapping the backdrop
  // -- staying open after navigating reads as broken, not intentional. A no-op on
  // desktop, where the sidebar is never in the closed state to begin with.
  useEffect(() => {
    close();
  }, [pathname, close]);

  useEffect(() => {
    if (isPublicPage) return;
    ensureAmplifyConfigured();
    fetchUserAttributes()
      .then((attrs) => setEmail(attrs.email ?? null))
      .catch(() => setEmail(null));
    apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false")
      .then((res) => setErrorCount(res.syncErrors.length))
      .catch(() => {});
    apiGet<ChannelState>("/admin/sync/state?channel=base")
      .then(setBaseState)
      .catch(() => {});
    apiGet<ChannelState>("/admin/sync/state?channel=ebay")
      .then(setEbayState)
      .catch(() => {});
  }, [isPublicPage]);

  if (isPublicPage) return null;

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      router.replace("/login");
    }
  }

  // The public GET /oauth/ebay/authorize route was removed (round 12 hardening --
  // "public OAuth authorize routeを廃止"): OAuth connect now always starts from this
  // authenticated admin session, via GET /admin/oauth/ebay/authorize-url, which mints the
  // signed state for *this caller's own* tenantId server-side rather than trusting a
  // client-supplied one.
  async function reconnectEbay() {
    try {
      const res = await apiGet<{ url: string }>("/admin/oauth/ebay/authorize-url");
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch {
      // Best-effort reconnect link in the sidebar -- a failure here just means nothing
      // opened; the same action is always also available from /onboarding or /commerce.
    }
  }

  const initial = email ? email[0]!.toUpperCase() : "?";

  return (
    <aside className="sidebar" data-open={open}>
      <Link href="/dashboard" className="app-brand sidebar-brand">
        <span className="app-brand-mark">AI</span>
        BASE <span className="app-brand-ebay">eBay</span> Sync
      </Link>
      <nav className="sidebar-nav">
        {LINKS.map((link) => {
          const Icon = link.icon;
          const active = pathname?.startsWith(link.href) || undefined;
          return (
            <Link key={link.href} href={link.href} data-active={active}>
              <Icon />
              {link.label}
              {link.href === "/sync-errors" && errorCount > 0 && <span className="sidebar-nav-badge">{errorCount}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-status">
        <div className="sidebar-status-row">
          <span className={`status-dot ${statusDotClass(baseState?.state)}`} />
          BASE {baseState ? (baseState.state === "HEALTHY" ? "接続済み" : baseState.state) : "確認中..."}
        </div>
        <div className="sidebar-status-row">
          <span className={`status-dot ${statusDotClass(ebayState?.state)}`} />
          eBay {ebayState ? (ebayState.state === "HEALTHY" ? "接続済み" : ebayState.state) : "確認中..."}
          {ebayState && ebayState.state !== "HEALTHY" && (
            <button type="button" onClick={reconnectEbay} className="reconnect-link">
              再接続
            </button>
          )}
        </div>
      </div>

      <ThemeToggle />

      <div className="sidebar-user">
        <span className="avatar">{initial}</span>
        <div className="sidebar-user-info">
          <div className="sidebar-user-email">{email ?? "..."}</div>
        </div>
        <button type="button" className="ghost" onClick={handleSignOut} disabled={signingOut} style={{ padding: "0.3rem 0.5rem" }}>
          {signingOut ? "..." : "ログアウト"}
        </button>
      </div>
    </aside>
  );
}
