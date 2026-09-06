"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

export default function AuditLogPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log")
      .then((res) => setEntries(res.auditLog))
      .catch((err) => notify(`監査ログの取得に失敗しました: ${(err as Error).message}`))
      .finally(() => setLoading(false));
  }, [ready, notify]);

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <h1>監査ログ</h1>
        </div>
        {!ready || loading ? (
          <SkeletonRows />
        ) : entries.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>ログはまだありません。</EmptyState>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>日時</th>
                  <th>実行者</th>
                  <th>操作</th>
                  <th>対象</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{new Date(entry.createdAt).toLocaleString("ja-JP")}</td>
                    <td>{entry.actor}</td>
                    <td>{entry.action}</td>
                    <td>
                      {entry.entityType}:{entry.entityId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
