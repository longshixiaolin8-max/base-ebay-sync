"use client";

import type { SyncError } from "@ai-ec/core";
import { fetchUserAttributes } from "aws-amplify/auth";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureAmplifyConfigured } from "@/lib/amplify-config";
import { apiGet } from "@/lib/api-client";
import { BellIcon, SearchIcon } from "@/components/icons";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "ダッシュボード",
  "/products": "商品マスター",
  "/commerce": "コマース統合",
  "/sync-errors": "同期エラー",
  "/audit-log": "監査ログ",
};

interface TopbarProps {
  /** When given, renders a functional search box that calls back on every keystroke
   *  instead of the plain decorative placeholder shown on pages with no list to filter. */
  onSearch?: (query: string) => void;
  searchPlaceholder?: string;
}

export function Topbar({ onSearch, searchPlaceholder }: TopbarProps) {
  const pathname = usePathname();
  const isLoginPage = pathname?.replace(/\/$/, "") === "/login";
  const [email, setEmail] = useState<string | null>(null);
  const [errorCount, setErrorCount] = useState(0);

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
      <div className="topbar-breadcrumb">
        ワークスペース / <strong>{title}</strong>
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
        <span className="avatar">{initial}</span>
      </div>
    </header>
  );
}
