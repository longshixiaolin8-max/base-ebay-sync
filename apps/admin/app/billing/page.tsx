"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { Tabs } from "@/components/ui/Tabs";
import PlanTab from "@/components/settings/PlanTab";
import ConnectionsTab from "@/components/settings/ConnectionsTab";
import NotificationsTab from "@/components/settings/NotificationsTab";
import PricingTab from "@/components/settings/PricingTab";
import SecurityTab from "@/components/settings/SecurityTab";

const TAB_ITEMS = [
  { id: "plan", label: "プラン" },
  { id: "connections", label: "接続設定" },
  { id: "notifications", label: "通知設定" },
  { id: "pricing", label: "価格設定" },
  { id: "security", label: "セキュリティ" },
];

const TAB_IDS = new Set(TAB_ITEMS.map((t) => t.id));

/**
 * This page's first `?tab=`-driven top-level tab (every other <Tabs> usage in this app is
 * local component state, not page navigation) -- deliberately kept at the existing /billing
 * route rather than renaming to /settings, since several existing links already point at
 * /billing (sync-error-copy.ts's actionHref, useRequireAuth's billing-inactive redirect,
 * the sidebar) and a route rename would silently break every one of them for a purely
 * cosmetic URL-slug difference.
 */
function BillingSettingsPage() {
  const { ready } = useRequireAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab = TAB_IDS.has(searchParams.get("tab") ?? "") ? (searchParams.get("tab") as string) : "plan";

  function setTab(id: string) {
    router.replace(`/billing/?tab=${id}`);
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>請求・設定</h1>
            <p className="page-lead">プランと支払い状況、外部接続、通知、価格設定、セキュリティをまとめて管理できます。</p>
          </div>
        </div>

        <Tabs tabs={TAB_ITEMS} active={activeTab} onChange={setTab} />

        <div style={{ marginTop: "1.25rem" }}>
          {!ready ? (
            <div className="card card-pad">読み込み中...</div>
          ) : activeTab === "plan" ? (
            <PlanTab />
          ) : activeTab === "connections" ? (
            <ConnectionsTab />
          ) : activeTab === "notifications" ? (
            <NotificationsTab />
          ) : activeTab === "pricing" ? (
            <PricingTab />
          ) : (
            <SecurityTab />
          )}
        </div>
      </div>
    </>
  );
}

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="page card card-pad">読み込み中...</div>}>
      <BillingSettingsPage />
    </Suspense>
  );
}
