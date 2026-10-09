"use client";

import type { SyncError } from "@ai-ec/core";
import { Fragment, useEffect, useState } from "react";
import { ApiError, apiGet, apiPost } from "@/lib/api-client";
import { planLabel, relativeTime } from "@/lib/format";
import { ERROR_CODE_LABEL } from "@/lib/sync-error-copy";
import { useRequireAuth } from "@/lib/use-require-auth";
import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";

interface TenantOpsSummary {
  id: string;
  name: string;
  plan: string;
  status: string;
  contactEmail: string | null;
  unresolvedErrorCount24h: number;
  isolatedChannels: string[];
  lastActivityAt: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  active: "有効",
  past_due: "支払い遅延",
  canceled_grace: "解約猶予中",
  canceled: "解約済み",
  pending_payment: "決済未完了",
};

/** Operator-only cross-tenant dashboard -- see requireOperator()'s own doc comment in
 *  admin-api's handler.ts for the access model. The Sidebar only links here for the
 *  configured operator email, but that's convenience, not the real gate: every call below
 *  403s server-side for anyone else regardless of whether this page itself is reachable. */
export default function OpsPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [tenants, setTenants] = useState<TenantOpsSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [expandedTenantId, setExpandedTenantId] = useState<string | null>(null);
  const [tenantErrors, setTenantErrors] = useState<SyncError[]>([]);
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<{ tenants: TenantOpsSummary[] }>("/admin/ops/tenants");
      setTenants(res.tenants);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setForbidden(true);
      } else {
        notify(`テナント一覧の取得に失敗しました: ${(err as Error).message}`);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready]);

  async function toggleExpand(tenantId: string) {
    if (expandedTenantId === tenantId) {
      setExpandedTenantId(null);
      return;
    }
    setExpandedTenantId(tenantId);
    setErrorsLoading(true);
    try {
      const res = await apiGet<{ syncErrors: SyncError[] }>(`/admin/ops/tenants/${tenantId}/sync-errors`);
      setTenantErrors(res.syncErrors);
    } catch (err) {
      notify(`エラー一覧の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setErrorsLoading(false);
    }
  }

  async function retryError(tenantId: string, errorId: string) {
    const key = `retry:${errorId}`;
    setBusyKey(key);
    try {
      await apiPost(`/admin/ops/tenants/${tenantId}/sync-errors/${errorId}/retry`);
      notify("再試行をキューに登録しました。", "success");
      const res = await apiGet<{ syncErrors: SyncError[] }>(`/admin/ops/tenants/${tenantId}/sync-errors`);
      setTenantErrors(res.syncErrors);
      await load();
    } catch (err) {
      notify(`再試行の登録に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function clearIsolation(tenantId: string, channel: string) {
    const key = `isolation:${tenantId}:${channel}`;
    setBusyKey(key);
    try {
      await apiPost(`/admin/ops/tenants/${tenantId}/channel-isolation/${channel}/clear`);
      notify(`${channel.toUpperCase()}の隔離を解除しました。`, "success");
      await load();
    } catch (err) {
      notify(`隔離解除に失敗しました: ${(err as Error).message}`);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>運営ダッシュボード</h1>
            <p className="page-lead">全テナントの同期状況を横断して確認し、必要なら再試行・隔離解除を行います。お客様からの連絡を待たずに障害に気付くための画面です。</p>
          </div>
        </div>

        {!ready || loading ? (
          <SkeletonRows count={4} />
        ) : forbidden ? (
          <div className="table-wrapper">
            <EmptyState>このアカウントには運営ダッシュボードへのアクセス権限がありません。</EmptyState>
          </div>
        ) : !tenants || tenants.length === 0 ? (
          <div className="table-wrapper">
            <EmptyState>テナントがありません。</EmptyState>
          </div>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>テナント</th>
                  <th>プラン</th>
                  <th>契約状態</th>
                  <th>未解決エラー(24h)</th>
                  <th>隔離中チャネル</th>
                  <th>最終アクティビティ</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <Fragment key={t.id}>
                    <tr>
                      <td>
                        <div>{t.name}</div>
                        {t.contactEmail && <div className="page-lead" style={{ fontSize: "0.8rem" }}>{t.contactEmail}</div>}
                      </td>
                      <td>{planLabel(t.plan)}</td>
                      <td>
                        <span className={t.status === "active" ? "badge ok" : t.status === "past_due" || t.status === "canceled_grace" ? "badge warn" : "badge error"}>
                          {STATUS_LABEL[t.status] ?? t.status}
                        </span>
                      </td>
                      <td>
                        <span className={t.unresolvedErrorCount24h > 0 ? "badge error" : "badge ok"}>{t.unresolvedErrorCount24h}件</span>
                      </td>
                      <td>
                        {t.isolatedChannels.length === 0 ? (
                          "—"
                        ) : (
                          t.isolatedChannels.map((channel) => (
                            <button
                              key={channel}
                              type="button"
                              className="secondary"
                              style={{ marginRight: "0.4rem" }}
                              disabled={busyKey === `isolation:${t.id}:${channel}`}
                              onClick={() => clearIsolation(t.id, channel)}
                            >
                              {channel.toUpperCase()}隔離解除
                            </button>
                          ))
                        )}
                      </td>
                      <td>{t.lastActivityAt ? relativeTime(new Date(t.lastActivityAt)) : "—"}</td>
                      <td>
                        <button type="button" className="secondary" onClick={() => toggleExpand(t.id)}>
                          {expandedTenantId === t.id ? "閉じる" : "詳細"}
                        </button>
                      </td>
                    </tr>
                    {expandedTenantId === t.id && (
                      <tr>
                        <td colSpan={7}>
                          {errorsLoading ? (
                            <SkeletonRows count={2} />
                          ) : tenantErrors.length === 0 ? (
                            <EmptyState>未解決のエラーはありません。</EmptyState>
                          ) : (
                            <div className="sync-error-card-list">
                              {tenantErrors.map((e) => {
                                const copy = ERROR_CODE_LABEL[e.errorCode];
                                return (
                                  <div key={e.id} className="sync-error-card">
                                    <div className="sync-error-card-main">
                                      <div className="sync-error-card-head">
                                        <span className="badge error">{copy?.title ?? e.errorCode}</span>
                                        {e.channel && <span className="badge">{e.channel.toUpperCase()}</span>}
                                      </div>
                                      <div className="sync-error-card-message">{copy?.summary ?? e.errorMessage}</div>
                                      <div className="sync-error-card-time">{relativeTime(e.createdAt)}</div>
                                    </div>
                                    {e.jobId && (
                                      <button
                                        type="button"
                                        className="secondary"
                                        onClick={() => retryError(t.id, e.id)}
                                        disabled={busyKey === `retry:${e.id}`}
                                      >
                                        {busyKey === `retry:${e.id}` ? "処理中..." : "再試行"}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
