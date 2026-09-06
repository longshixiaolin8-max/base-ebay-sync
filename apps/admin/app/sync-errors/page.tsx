"use client";

import type { SyncError } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { useToast } from "@/components/Toast";

export default function SyncErrorsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
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
      notify("再試行をキューに登録しました。", "success");
      await load();
    } catch (err) {
      notify(`再試行の登録に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>同期エラー</h1>
          <p className="page-lead">
            SQSの再試行上限(DLQ送出)に達した、またはeBay/BASE APIが失敗したジョブを表示します。「再試行」でキューへ再投入できます。
          </p>
        </div>
      </div>
      {!ready || loading ? (
        <SkeletonRows />
      ) : errors.length === 0 ? (
        <div className="table-wrapper">
          <EmptyState>未解決のエラーはありません。</EmptyState>
        </div>
      ) : (
        <div className="table-wrapper">
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
                  <td style={{ whiteSpace: "nowrap" }}>{new Date(e.createdAt).toLocaleString("ja-JP")}</td>
                  <td>{e.channel ?? "-"}</td>
                  <td>
                    <span className="badge error">{e.errorCode}</span>
                  </td>
                  <td style={{ maxWidth: 480 }}>{e.errorMessage}</td>
                  <td>
                    {e.jobId && (
                      <button onClick={() => retry(e.id)} disabled={busyId === e.id} className="secondary">
                        {busyId === e.id ? "処理中..." : "再試行"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
