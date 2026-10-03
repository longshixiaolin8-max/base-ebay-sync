"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPost } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Topbar } from "@/components/Topbar";
import { useToast } from "@/components/Toast";
import { PageHeader } from "@/components/ui/PageHeader";
import { KpiCard } from "@/components/ui/KpiCard";
import { AlertIcon, BoxIcon, ClockIcon, ShieldIcon, TagIcon, TrendUpIcon } from "@/components/icons";
import { jobChannel } from "@/lib/sync-job-copy";
import { ConnectionCard } from "@/components/channel-sync/ConnectionCard";
import { IsolationCard } from "@/components/channel-sync/IsolationCard";
import { SyncPipeline } from "@/components/channel-sync/SyncPipeline";
import { JobQueueTable } from "@/components/channel-sync/JobQueueTable";
import { JobDetailDrawer } from "@/components/channel-sync/JobDetailDrawer";
import { SyncErrorsTable } from "@/components/channel-sync/SyncErrorsTable";
import type { ConnectionsResponse, PipelineResponse, SyncErrorRow, SyncJobCounts, SyncJobRow } from "@/components/channel-sync/types";

interface SloConfidence {
  score: number;
}
interface SloSummary {
  syncSuccessRate: { base: SloConfidence; ebay: SloConfidence };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function ChannelSyncPage() {
  const { ready } = useRequireAuth();
  const { notify } = useToast();

  const [connections, setConnections] = useState<ConnectionsResponse | null>(null);
  const [connectionsLoading, setConnectionsLoading] = useState(true);
  const [checkingConnections, setCheckingConnections] = useState(false);

  const [slo, setSlo] = useState<SloSummary | null>(null);

  const [from, setFrom] = useState(() => isoDate(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(() => isoDate(new Date()));
  const [pipeline, setPipeline] = useState<PipelineResponse | null>(null);

  const [jobs, setJobs] = useState<SyncJobRow[]>([]);
  const [jobCounts, setJobCounts] = useState<SyncJobCounts | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  const [statusTab, setStatusTab] = useState("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [selectedJobIds, setSelectedJobIds] = useState<Set<string>>(new Set());
  const [detailJob, setDetailJob] = useState<SyncJobRow | null>(null);
  const [retryingJobId, setRetryingJobId] = useState<string | null>(null);
  const [bulkRetrying, setBulkRetrying] = useState(false);

  const [errors, setErrors] = useState<SyncErrorRow[]>([]);
  const [errorsLoading, setErrorsLoading] = useState(true);
  const [retryingErrorId, setRetryingErrorId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    try {
      const res = await apiGet<ConnectionsResponse>("/admin/sync/connections");
      setConnections(res);
    } catch (err) {
      notify(`接続状況の取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setConnectionsLoading(false);
      setCheckingConnections(false);
    }
  }, [notify]);

  const loadSlo = useCallback(async () => {
    try {
      setSlo(await apiGet<SloSummary>("/admin/slo?windowHours=24"));
    } catch {
      // Non-critical for this page -- the confidence gauge just shows "確認中..." if this fails.
    }
  }, []);

  const loadPipeline = useCallback(async () => {
    try {
      const res = await apiGet<PipelineResponse>(`/admin/sync/pipeline?from=${from}&to=${to}`);
      setPipeline(res);
    } catch (err) {
      notify(`同期パイプラインの取得に失敗しました: ${(err as Error).message}`);
    }
  }, [from, to, notify]);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const query = statusTab === "all" ? "" : `?status=${statusTab}`;
      const res = await apiGet<{ jobs: SyncJobRow[]; counts: SyncJobCounts }>(`/admin/sync/jobs${query}`);
      setJobs(res.jobs);
      setJobCounts(res.counts);
      setSelectedJobIds(new Set());
    } catch (err) {
      notify(`同期ジョブキューの取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setJobsLoading(false);
    }
  }, [statusTab, notify]);

  const loadErrors = useCallback(async () => {
    setErrorsLoading(true);
    try {
      const res = await apiGet<{ syncErrors: SyncErrorRow[] }>("/admin/sync-errors?resolved=false");
      setErrors(res.syncErrors);
    } catch (err) {
      notify(`同期エラーの取得に失敗しました: ${(err as Error).message}`);
    } finally {
      setErrorsLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (!ready) return;
    void loadConnections();
    void loadSlo();
    void loadErrors();
  }, [ready, loadConnections, loadSlo, loadErrors]);

  useEffect(() => {
    if (ready) void loadPipeline();
  }, [ready, loadPipeline]);

  useEffect(() => {
    if (ready) void loadJobs();
  }, [ready, loadJobs]);

  async function handleReconnect(channel: "base" | "ebay") {
    try {
      const res = await apiGet<{ url: string }>(`/admin/oauth/${channel}/authorize-url`);
      window.open(res.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      notify(`再接続用リンクの取得に失敗しました: ${(err as Error).message}`);
    }
  }

  async function handleCheckConnections() {
    setCheckingConnections(true);
    await loadConnections();
  }

  async function handleRowRetry(id: string) {
    setRetryingJobId(id);
    try {
      await apiPost(`/admin/sync/jobs/${id}/retry`);
      notify("次回の同期ポーリングで再試行されます。", "success");
      await loadJobs();
    } catch (err) {
      notify(`再試行に失敗しました: ${(err as Error).message}`);
    } finally {
      setRetryingJobId(null);
    }
  }

  async function handleBulkRetry() {
    setBulkRetrying(true);
    try {
      const res = await apiPost<{ retried: number }>("/admin/sync/jobs/bulk-retry", { ids: [...selectedJobIds] });
      notify(`${res.retried}件を再試行対象にしました。`, "success");
      await loadJobs();
    } catch (err) {
      notify(`一括再試行に失敗しました: ${(err as Error).message}`);
    } finally {
      setBulkRetrying(false);
    }
  }

  async function handleErrorRetry(id: string) {
    setRetryingErrorId(id);
    try {
      await apiPost(`/admin/sync-errors/${id}/retry`);
      notify("再試行をキューに登録しました。", "success");
      await Promise.all([loadErrors(), loadJobs()]);
    } catch (err) {
      notify(`再試行の登録に失敗しました: ${(err as Error).message}`);
    } finally {
      setRetryingErrorId(null);
    }
  }

  function toggleJobSelect(id: string) {
    setSelectedJobIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    const visible = jobs.filter((j) => channelFilter === "all" || jobChannel(j.type, j.payload) === channelFilter);
    setSelectedJobIds((prev) => (prev.size === visible.length ? new Set() : new Set(visible.map((j) => j.id))));
  }

  const confidenceScore = useMemo(() => {
    if (!slo) return null;
    return Math.round((slo.syncSuccessRate.base.score + slo.syncSuccessRate.ebay.score) / 2);
  }, [slo]);

  const isolatedCount = useMemo(() => {
    if (!connections) return 0;
    return [connections.base.state, connections.ebay.state].filter((s) => s === "ISOLATED").length;
  }, [connections]);

  return (
    <>
      <Topbar />
      <div className="page">
        <PageHeader
          title="チャネル同期"
          lead="BASE・中央データベース・eBay 間の同期ジョブ、接続状況、公開・更新のパイプラインを監視・操作できます。"
          actions={
            <div className="draft-date-range">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to} />
              〜
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from} max={isoDate(new Date())} />
            </div>
          }
        />

        <div className="kpi-grid">
          <KpiCard
            icon={BoxIcon}
            color="blue"
            value={connectionsLoading ? "..." : connections?.base.state === "HEALTHY" ? "正常" : (connections?.base.state ?? "—")}
            label="BASE接続"
          />
          <KpiCard
            icon={TagIcon}
            color="orange"
            value={connectionsLoading ? "..." : connections?.ebay.state === "HEALTHY" ? "正常" : (connections?.ebay.state ?? "—")}
            label="eBay接続"
          />
          <KpiCard icon={TrendUpIcon} color="green" value={confidenceScore === null ? "..." : `${confidenceScore}%`} label="同期成功率" />
          <KpiCard icon={ClockIcon} color="blue" value={jobCounts?.pending ?? "..."} label="待機ジョブ" />
          <KpiCard icon={AlertIcon} color="red" value={jobCounts?.failed ?? "..."} label="失敗ジョブ" />
          <KpiCard icon={ShieldIcon} color={isolatedCount > 0 ? "red" : "green"} value={isolatedCount} label="隔離チャネル数" />
        </div>

        <div className="channel-sync-connections">
          <ConnectionCard
            channel="base"
            detail={connections?.base ?? null}
            loading={connectionsLoading}
            onCheck={handleCheckConnections}
            onReconnect={() => handleReconnect("base")}
            checking={checkingConnections}
          />
          <ConnectionCard
            channel="ebay"
            detail={connections?.ebay ?? null}
            loading={connectionsLoading}
            onCheck={handleCheckConnections}
            onReconnect={() => handleReconnect("ebay")}
            checking={checkingConnections}
          />
          <div className="card card-pad">
            <IsolationCard base={connections?.base ?? null} ebay={connections?.ebay ?? null} confidenceScore={confidenceScore} />
          </div>
        </div>

        <div className="card card-pad">
          <h2 style={{ marginBottom: "0.75rem" }}>同期パイプライン</h2>
          <SyncPipeline data={pipeline} />
        </div>

        <JobQueueTable
          jobs={jobs}
          counts={jobCounts}
          loading={jobsLoading}
          statusTab={statusTab}
          onStatusTabChange={setStatusTab}
          channelFilter={channelFilter}
          onChannelFilterChange={setChannelFilter}
          selectedIds={selectedJobIds}
          onToggleSelect={toggleJobSelect}
          onToggleSelectAll={toggleSelectAll}
          onBulkRetry={handleBulkRetry}
          bulkRetrying={bulkRetrying}
          onRowRetry={handleRowRetry}
          retryingId={retryingJobId}
          onOpenDetail={setDetailJob}
        />

        <SyncErrorsTable errors={errors} loading={errorsLoading} onRetry={handleErrorRetry} retryingId={retryingErrorId} />
      </div>

      <JobDetailDrawer job={detailJob} onClose={() => setDetailJob(null)} />
    </>
  );
}
