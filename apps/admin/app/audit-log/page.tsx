"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function AuditLogPage() {
  const { ready } = useRequireAuth();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!ready) return;
    apiGet<{ auditLog: AuditLogEntry[] }>("/admin/audit-log")
      .then((res) => setEntries(res.auditLog))
      .finally(() => setLoading(false));
  }, [ready]);

  if (!ready || loading) return <p>読み込み中...</p>;

  return (
    <div>
      <h1>監査ログ</h1>
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
              <td>{new Date(entry.createdAt).toLocaleString("ja-JP")}</td>
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
  );
}
