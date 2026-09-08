"use client";

import type { SyncError } from "@ai-ec/core";
import Link from "next/link";
import { useEffect, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { ERROR_CODE_LABEL } from "@/lib/sync-error-copy";

export default function SyncErrorsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [errors, setErrors] = useState<SyncError[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await apiGet<{ syncErrors: SyncError[] }>("/admin/sync-errors?resolved=false");
      setErrors(res.syncErrors);
    } catch (err) {
      setLoadError(true);
      notify(`同期エラー一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
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
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>同期エラー</h1>
            <p className="page-lead">
              BASE/eBayとの連携で失敗した処理を表示します。カードを開くと原因と対応方法を確認できます。
            </p>
          </div>
        </div>
        {!ready || loading ? (
          <SkeletonRows />
        ) : loadError ? (
          <div className="table-wrapper">
            <EmptyState>
              読み込みに失敗しました。
              <button type="button" className="secondary" style={{ marginLeft: "0.6rem" }} onClick={() => load()}>
                再試行
              </button>
            </EmptyState>
          </div>
        ) : errors.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>未解決のエラーはありません。</EmptyState>
          </div>
        ) : (
          <div className="sync-error-card-list">
            {errors.map((e) => {
              const copy = ERROR_CODE_LABEL[e.errorCode];
              return (
                <div key={e.id} className="sync-error-card">
                  <Link href={`/sync-errors/detail?id=${e.id}`} className="sync-error-card-main">
                    <div className="sync-error-card-head">
                      <span className="badge error">{copy?.title ?? e.errorCode}</span>
                      {e.channel && <span className="badge">{e.channel.toUpperCase()}</span>}
                    </div>
                    <div className="sync-error-card-message">{copy?.summary ?? e.errorMessage}</div>
                    <div className="sync-error-card-time">{new Date(e.createdAt).toLocaleString("ja-JP")}</div>
                  </Link>
                  {e.jobId && (
                    <button type="button" className="secondary" onClick={() => retry(e.id)} disabled={busyId === e.id}>
                      {busyId === e.id ? "処理中..." : "再試行"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
