"use client";

import type { SyncError } from "@ai-ec/core";
import { fetchUserAttributes } from "aws-amplify/auth";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { apiGet } from "@/lib/api-client";
import { useSignOut } from "@/lib/use-sign-out";
import { useMobileNav } from "@/components/MobileNav";
import { BellIcon, MenuIcon, SearchIcon } from "@/components/icons";
import { DropdownMenu } from "@/components/ui/DropdownMenu";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "ダッシュボード",
  "/onboarding": "導入設定",
  "/products": "商品マスター",
  "/drafts": "AI出品下書き",
  "/channel-sync": "チャネル同期",
  "/inventory": "在庫監視",
  "/analytics": "分析",
  "/commerce": "コマース統合",
  "/orders": "注文管理",
  "/sync-errors": "同期エラー",
  "/system-health": "システム状態",
  "/audit-log": "監査ログ",
  "/billing": "請求・設定",
};

interface TopbarProps {
  /** When given, renders a functional search box that calls back on every keystroke
   *  instead of the plain decorative placeholder shown on pages with no list to filter. */
  onSearch?: (query: string) => void;
  searchPlaceholder?: string;
}

export function Topbar({ onSearch, searchPlaceholder }: TopbarProps) {
  const pathname = usePathname();
  const { toggle } = useMobileNav();
  const isLoginPage = pathname?.replace(/\/$/, "") === "/login";
  const [email, setEmail] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);
  const { signingOut, handleSignOut } = useSignOut();

  useEffect(() => {
    if (isLoginPage) return;
    ensureAmplifyConfigured();
    fetchUserAttributes()
      .then((attrs) => setEmail(attrs.email ?? null))
      .catch(() => setEmail(null));
    apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false")
      .then((res) => setErrorCount(res.syncErrors.length))
      .catch(() => {});
  }, [isLoginPage]);

  if (isLoginPage) return null;

  const activeEntry = Object.entries(PAGE_TITLES).find(([href]) => pathname?.startsWith(href));
  const title = activeEntry?.[1] ?? "";
  const initial = email ? email[0]!.toUpperCase() : "?";

  return (
    <header className="app-topbar">
      <button type="button" className="icon-button menu-button" onClick={toggle} aria-label="メニューを開く">
        <MenuIcon />
      </button>
      <div className="topbar-breadcrumb">
        <span className="topbar-breadcrumb-prefix">ワークスペース / </span>
        <strong>{title}</strong>
      </div>
      <div className="topbar-search">
        <SearchIcon />
        <input
          type="text"
          placeholder={searchPlaceholder ?? "商品名・SKUで検索..."}
          onChange={(e) => onSearch?.(e.target.value)}
          disabled={!onSearch}
        />
      </div>
      <div className="topbar-actions">
        <Link href="/sync-errors" className="icon-button" aria-label="同期エラー通知">
          <BellIcon />
          {errorCount > 0 && <span className="icon-button-badge">{errorCount > 99 ? "99+" : errorCount}</span>}
        </Link>
        <DropdownMenu label="アカウントメニュー" align="right" trigger={<span className="avatar">{initial}</span>}>
          <div className="dropdown-menu-meta">
            <div className="dropdown-menu-meta-name">{email ?? "..."}</div>
          </div>
          <Link href="/billing" className="dropdown-menu-item">
            請求・プラン
          </Link>
          <button type="button" className="dropdown-menu-item" onClick={handleSignOut} disabled={signingOut}>
            {signingOut ? "ログアウト中..." : "ログアウト"}
          </button>
        </DropdownMenu>
      </div>
    </header>
  );
}
