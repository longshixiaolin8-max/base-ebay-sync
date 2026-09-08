"use client";

import type { AuditLogEntry, ProductMaster } from "@ai-ec/core";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AUDIT_ACTION_LABEL } from "@/lib/audit-action-copy";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { DownloadIcon } from "@/components/icons";

const ENTITY_TYPE_LABEL: Record<string, string> = {
  product: "商品",
  order: "注文",
  ai_listing_draft: "AIドラフト",
  sync_error: "同期エラー",
  tenant: "契約",
  queue: "キュー",
  ebay_location: "eBay在庫拠点",
  ebay_account: "eBayアカウント",
  oauth_connection: "外部連携",
  channel: "販路",
};

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatJsonValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function DiffTable({ before, after }: { before: unknown; after: unknown }) {
  const beforeObj = before && typeof before === "object" ? (before as Record<string, unknown>) : null;
  const afterObj = after && typeof after === "object" ? (after as Record<string, unknown>) : null;
  const keys = Array.from(new Set([...(beforeObj ? Object.keys(beforeObj) : []), ...(afterObj ? Object.keys(afterObj) : [])]));

  if (keys.length === 0 && before === null && after === null) {
    return <p style={{ fontSize: "0.82rem", color: "var(--fg-subtle)", margin: "0.4rem 0 0" }}>変更前後の記録はありません。</p>;
  }

  return (
    <dl className="kv-list" style={{ marginTop: "0.5rem" }}>
      {keys.length > 0 ? (
        keys.map((key) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              {formatJsonValue(beforeObj?.[key])} → {formatJsonValue(afterObj?.[key])}
            </dd>
          </div>
        ))
      ) : (
        <div>
          <dt>変更後</dt>
          <dd>{formatJsonValue(after)}</dd>
        </div>
      )}
    </dl>
  );
}

export default function AuditLogPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [productTitleById, setProductTitleById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [periodFilter, setPeriodFilter] = useState<"all" | "this_month" | "last_month">("all");
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");

  useEffect(() => {
    if (!ready) return;
    Promise.all([
      apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log"),
      apiGet<{ products: ProductMaster[] }>("/admin/products").catch(() => ({ products: [] as ProductMaster[] })),
    ])
      .then(([logRes, productsRes]) => {
        setEntries(logRes.auditLog);
        setProductTitleById(Object.fromEntries(productsRes.products.map((p) => [p.id, p.title])));
      })
      .catch((err) => notify(`監査ログの取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [ready, notify]);

  const actors = useMemo(() => Array.from(new Set(entries.map((e) => e.actor))).sort(), [entries]);
  const actions = useMemo(() => Array.from(new Set(entries.map((e) => e.action))).sort(), [entries]);

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (actorFilter !== "all" && e.actor !== actorFilter) return false;
      if (actionFilter !== "all" && e.action !== actionFilter) return false;
      const created = new Date(e.createdAt);
      if (periodFilter === "this_month" && created < thisMonthStart) return false;
      if (periodFilter === "last_month" && (created < lastMonthStart || created >= thisMonthStart)) return false;
      return true;
    });
  }, [entries, actorFilter, actionFilter, periodFilter]);

  const groups = useMemo(() => {
    const map = new Map<string, AuditLogEntry[]>();
    for (const entry of filtered) {
      const key = new Date(entry.createdAt).toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    }
    return Array.from(map.entries());
  }, [filtered]);

  function targetLabel(entry: AuditLogEntry): string {
    if (entry.entityType === "product" && productTitleById[entry.entityId]) {
      return productTitleById[entry.entityId];
    }
    const label = ENTITY_TYPE_LABEL[entry.entityType] ?? entry.entityType;
    return `${label} (${entry.entityId.slice(0, 8)})`;
  }

  function exportCsv() {
    const header = ["日時", "実行者", "操作", "対象"];
    const lines = filtered.map((e) =>
      [new Date(e.createdAt).toLocaleString("ja-JP"), e.actor, AUDIT_ACTION_LABEL[e.action] ?? e.action, targetLabel(e)]
        .map(csvEscape)
        .join(","),
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>監査ログ</h1>
            <p className="page-lead">アカウントの操作履歴を時系列で確認できます(直近200件)。</p>
          </div>
          <button type="button" className="secondary" onClick={exportCsv} disabled={filtered.length === 0}>
            <DownloadIcon /> CSV出力
          </button>
        </div>

        <div className="filter-tabs" style={{ marginBottom: "1rem", flexWrap: "wrap", gap: "0.6rem" }}>
          <select value={periodFilter} onChange={(e) => setPeriodFilter(e.target.value as typeof periodFilter)}>
            <option value="all">すべての期間</option>
            <option value="this_month">今月</option>
            <option value="last_month">先月</option>
          </select>
          <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
            <option value="all">すべての操作者</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
            <option value="all">すべての操作</option>
            {actions.map((a) => (
              <option key={a} value={a}>
                {AUDIT_ACTION_LABEL[a] ?? a}
              </option>
            ))}
          </select>
        </div>

        {!ready || loading ? (
          <SkeletonRows />
        ) : filtered.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>{entries.length === 0 ? "ログはまだありません。" : "条件に一致するログがありません。"}</EmptyState>
          </div>
        ) : (
          <div className="audit-timeline">
            {groups.map(([dateLabel, dayEntries]) => (
              <div key={dateLabel} className="audit-day-group">
                <div className="audit-day-header">{dateLabel}</div>
                {dayEntries.map((entry) => {
                  const expanded = expandedId === entry.id;
                  return (
                    <div key={entry.id} className="audit-entry">
                      <button
                        type="button"
                        className="audit-entry-main"
                        onClick={() => setExpandedId(expanded ? null : entry.id)}
                        aria-expanded={expanded}
                      >
                        <span className="avatar" aria-hidden="true">
                          {entry.actor[0]?.toUpperCase() ?? "?"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: "block", fontWeight: 600 }}>{entry.actor}</span>
                          <span style={{ display: "block", fontSize: "0.82rem", color: "var(--fg-muted)" }}>
                            {AUDIT_ACTION_LABEL[entry.action] ?? entry.action} — {targetLabel(entry)}
                          </span>
                        </span>
                        <span style={{ fontSize: "0.78rem", color: "var(--fg-subtle)", flexShrink: 0 }}>
                          {new Date(entry.createdAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                        <span style={{ color: "var(--fg-subtle)" }}>{expanded ? "▲" : "▼"}</span>
                      </button>
                      {expanded && (
                        <div className="audit-entry-detail">
                          <DiffTable before={entry.before} after={entry.after} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
