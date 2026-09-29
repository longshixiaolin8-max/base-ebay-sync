import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { Select } from "@/components/ui/Select";
import { Tabs } from "@/components/ui/Tabs";
import { jobChannel, JOB_STATUS_LABEL, JOB_TYPE_LABEL } from "@/lib/sync-job-copy";
import type { SyncJobCounts, SyncJobRow } from "./types";

const STATUS_BADGE_TONE: Record<SyncJobRow["status"], "neutral" | "ok" | "error"> = {
  pending: "neutral",
  completed: "ok",
  failed: "error",
};

const CHANNEL_LABEL: Record<string, string> = { base: "BASE", ebay: "eBay" };

interface JobQueueTableProps {
  jobs: SyncJobRow[];
  counts: SyncJobCounts | null;
  loading: boolean;
  statusTab: string;
  onStatusTabChange: (id: string) => void;
  channelFilter: string;
  onChannelFilterChange: (value: string) => void;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onBulkRetry: () => void;
  bulkRetrying: boolean;
  onRowRetry: (id: string) => void;
  retryingId: string | null;
  onOpenDetail: (job: SyncJobRow) => void;
}

export function JobQueueTable({
  jobs,
  counts,
  loading,
  statusTab,
  onStatusTabChange,
  channelFilter,
  onChannelFilterChange,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onBulkRetry,
  bulkRetrying,
  onRowRetry,
  retryingId,
  onOpenDetail,
}: JobQueueTableProps) {
  const visibleJobs = jobs.filter((j) => channelFilter === "all" || jobChannel(j.type, j.payload) === channelFilter);
  const selectedFailedCount = visibleJobs.filter((j) => selectedIds.has(j.id) && j.status === "failed").length;
  const allSelected = visibleJobs.length > 0 && visibleJobs.every((j) => selectedIds.has(j.id));

  return (
    <div className="card card-pad">
      <div className="job-queue-toolbar">
        <Tabs
          tabs={[
            { id: "all", label: `すべて ${counts?.all ?? 0}` },
            { id: "pending", label: `待機中 ${counts?.pending ?? 0}` },
            { id: "completed", label: `成功 ${counts?.completed ?? 0}` },
            { id: "failed", label: `失敗 ${counts?.failed ?? 0}` },
          ]}
          active={statusTab}
          onChange={onStatusTabChange}
        />
        <Select label="チャネル" value={channelFilter} onChange={onChannelFilterChange}>
          <option value="all">すべてのチャネル</option>
          <option value="base">BASE</option>
          <option value="ebay">eBay</option>
        </Select>
      </div>

      <div className="job-queue-bulk-bar">
        <Checkbox checked={allSelected} onChange={onToggleSelectAll} label="すべて選択" />
        <button type="button" className="secondary" onClick={onBulkRetry} disabled={selectedFailedCount === 0 || bulkRetrying}>
          {bulkRetrying ? "再試行中..." : `一括再試行(${selectedFailedCount})`}
        </button>
        <button type="button" className="secondary" disabled title="チャネルの隔離は失敗パターンから自動的に判定・解除される仕組みで、手動での隔離操作には現在対応していません">
          チャネルを隔離
        </button>
        <button
          type="button"
          className="secondary"
          disabled
          title="DLQの自動再処理は30分ごとに実行されています。手動での即時再実行には現在対応していません"
        >
          DLQを再実行
        </button>
      </div>

      {loading ? (
        <SkeletonRows />
      ) : visibleJobs.length === 0 ? (
        <EmptyState>該当する同期ジョブはありません。</EmptyState>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th aria-label="選択" />
                <th>ジョブ種別</th>
                <th>商品</th>
                <th>チャネル</th>
                <th>ステータス</th>
                <th>試行回数</th>
                <th>Idempotency Key</th>
                <th>更新時刻</th>
                <th aria-label="アクション" />
              </tr>
            </thead>
            <tbody>
              {visibleJobs.map((job) => {
                const channel = jobChannel(job.type, job.payload);
                return (
                  <tr key={job.id}>
                    <td>
                      <Checkbox
                        checked={selectedIds.has(job.id)}
                        onChange={() => onToggleSelect(job.id)}
                        label={`${job.id}を選択`}
                        labelHidden
                      />
                    </td>
                    <td>{JOB_TYPE_LABEL[job.type] ?? job.type}</td>
                    <td>
                      {job.productTitle ? (
                        <>
                          {job.productTitle}
                          <div className="job-queue-sku">{job.productSku}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{channel ? CHANNEL_LABEL[channel] : "—"}</td>
                    <td>
                      <Badge tone={STATUS_BADGE_TONE[job.status]}>{JOB_STATUS_LABEL[job.status] ?? job.status}</Badge>
                    </td>
                    <td>{job.attempts}</td>
                    <td className="job-queue-key">{job.idempotencyKey}</td>
                    <td>{new Date(job.updatedAt).toLocaleString("ja-JP")}</td>
                    <td className="job-queue-actions">
                      {job.status === "failed" && (
                        <button type="button" className="secondary" onClick={() => onRowRetry(job.id)} disabled={retryingId === job.id}>
                          {retryingId === job.id ? "..." : "再試行"}
                        </button>
                      )}
                      <button type="button" className="secondary" onClick={() => onOpenDetail(job)}>
                        詳細を見る
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
