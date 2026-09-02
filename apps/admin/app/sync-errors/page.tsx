"use client";

import type { SyncError } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";

export default function SyncErrorsPage() {
  const { ready } = useRequireAuth();
  const [errors, setErrors] = useState<SyncError[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false");
    setErrors(res.syncErrors);
    setLoading(false);
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function retry(id: string) {
    setBusyId(id);
    try {
      await apiPost(`/admin/sync-errors/${id}/retry`);
      await load();
    } catch (err) {
      alert(`再試行の登録に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  if (!ready || loading) return <p>読み込み中...</p>;

  return (
    <div>
      <h1>同期エラー</h1>
      <p style={{ color: "#666", fontSize: "0.9rem" }}>
        SQSの再試行上限(DLQ送出)に達した、またはeBay/BASE APIが失敗したジョブを表示します。「再試行」でキューへ再投入できます。
      </p>
      {errors.length === 0 ? (
        <p>未解決のエラーはありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>発生日時</th>
              <th>チャネル</th>
              <th>エラーコード</th>
              <th>内容</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {errors.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.createdAt).toLocaleString("ja-JP")}</td>
                <td>{e.channel ?? "-"}</td>
                <td>
                  <span className="badge error">{e.errorCode}</span>
                </td>
                <td style={{ maxWidth: 480 }}>{e.errorMessage}</td>
                <td>
                  {e.jobId && (
                    <button onClick={() => retry(e.id)} disabled={busyId === e.id}>
                      {busyId === e.id ? "処理中..." : "再試行"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
