"use client";

import type { AuditLogEntry } from "@ai-ec/core";
import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { AUDIT_ACTION_LABEL } from "@/lib/audit-action-copy";
import { SkeletonRows, EmptyState } from "@/components/Skeleton";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { RefreshIcon } from "@/components/icons";

interface SyncConfidence {
  channel: string;
  score: number;
  windowHours: number;
  successCount: number;
  failureCount: number;
  outOfOrderEventCount: number;
  totalEventCount: number;
}

interface SloSummary {
  windowHours: number;
  syncSuccessRate: { base: SyncConfidence; ebay: SyncConfidence };
  inventoryInconsistencyCount: number;
  aiFailureRate: { failureCount: number; attemptCount: number; rate: number | null };
  dlqDepths: Record<string, number> | null;
  recentAutoRecoveryEvents: AuditLogEntry[];
}

const DLQ_LABEL: Record<string, string> = {
  aiGenerate: "AI生成",
  ebaySync: "eBay同期",
  inventorySync: "在庫同期",
};

function scoreTone(score: number): string {
  if (score >= 80) return "var(--success)";
  if (score >= 50) return "var(--warn)";
  return "var(--danger)";
}

export default function SystemHealthPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();
  const [windowHours, setWindowHours] = useState(24);
  const [data, setData] = useState<SloSummary | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await apiGet<SloSummary>(`/admin/slo?windowHours=${windowHours}`);
      setData(res);
    } catch (err) {
      notify(`システム状態の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (ready) void load();
  }, [ready, windowHours]);

  return (
    <>
      <Topbar />
      <div className="page">
        <div className="page-header">
          <div>
            <h1>システム状態</h1>
            <p className="page-lead">同期の信頼性・在庫整合性・AI生成・失敗ジョブの状況を、集計期間を選んで確認します。</p>
          </div>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <div className="filter-tabs">
              {[24, 24 * 7, 24 * 30].map((h) => (
                <button key={h} type="button" className="filter-tab" data-active={windowHours === h} onClick={() => setWindowHours(h)}>
                  {h === 24 ? "24時間" : h === 24 * 7 ? "7日間" : "30日間"}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void load()} disabled={loading}>
              <RefreshIcon /> 更新
            </button>
          </div>
        </div>

        {!ready || loading || !data ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            <div className="kpi-grid">
              <div className="kpi-card">
                <div className="kpi-value" style={{ color: scoreTone(data.syncSuccessRate.base.score) }}>
                  {data.syncSuccessRate.base.score}
                </div>
                <div className="kpi-label">BASE同期信頼度スコア</div>
                <div className="kpi-sub">
                  成功 {data.syncSuccessRate.base.successCount} / 失敗 {data.syncSuccessRate.base.failureCount}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value" style={{ color: scoreTone(data.syncSuccessRate.ebay.score) }}>
                  {data.syncSuccessRate.ebay.score}
                </div>
                <div className="kpi-label">eBay同期信頼度スコア</div>
                <div className="kpi-sub">
                  成功 {data.syncSuccessRate.ebay.successCount} / 失敗 {data.syncSuccessRate.ebay.failureCount}
                </div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value" style={{ color: data.inventoryInconsistencyCount > 0 ? "var(--danger)" : undefined }}>
                  {data.inventoryInconsistencyCount}
                </div>
                <div className="kpi-label">在庫不整合(検知件数)</div>
                <div className="kpi-sub">商品詳細の「在庫を再構築」で解消できます</div>
              </div>
              <div className="kpi-card">
                <div className="kpi-value">
                  {data.aiFailureRate.rate === null ? "—" : `${(data.aiFailureRate.rate * 100).toFixed(1)}%`}
                </div>
                <div className="kpi-label">AI生成失敗率</div>
                <div className="kpi-sub">
                  {data.aiFailureRate.failureCount} / {data.aiFailureRate.attemptCount}件
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1.25rem", marginTop: "1.5rem" }}>
              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.75rem" }}>失敗キュー(DLQ)の滞留</h2>
                {data.dlqDepths === null ? (
                  <p style={{ fontSize: "0.85rem", color: "var(--fg-subtle)" }}>DLQ情報を取得できませんでした。</p>
                ) : Object.values(data.dlqDepths).every((v) => v === 0) ? (
                  <EmptyState>滞留しているジョブはありません。</EmptyState>
                ) : (
                  Object.entries(data.dlqDepths).map(([key, count]) => (
                    <div key={key} className="dashboard-sync-row">
                      <span>{DLQ_LABEL[key] ?? key}</span>
                      <span className={count > 0 ? "badge error" : "badge ok"}>{count}件</span>
                    </div>
                  ))
                )}
              </div>

              <div className="card card-pad">
                <h2 style={{ marginBottom: "0.75rem" }}>自動復旧イベント</h2>
                {data.recentAutoRecoveryEvents.length === 0 ? (
                  <EmptyState>この期間の自動復旧イベントはありません。</EmptyState>
                ) : (
                  data.recentAutoRecoveryEvents.map((entry) => (
                    <div key={entry.id} className="recent-sync-item">
                      <div>
                        <div>{AUDIT_ACTION_LABEL[entry.action] ?? entry.action}</div>
                        <div className="recent-sync-time">{new Date(entry.createdAt).toLocaleString("ja-JP")}</div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
