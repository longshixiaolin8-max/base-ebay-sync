import Link from "next/link";
import { EmptyState, SkeletonRows } from "@/components/Skeleton";
import { Badge } from "@/components/ui/Badge";
import { relativeTime } from "@/lib/format";
import { JOB_TYPE_LABEL } from "@/lib/sync-job-copy";
import { ERROR_CODE_LABEL } from "@/lib/sync-error-copy";
import type { SyncErrorRow } from "./types";

const CHANNEL_LABEL: Record<string, string> = { base: "BASE", ebay: "eBay" };

interface SyncErrorsTableProps {
  errors: SyncErrorRow[];
  loading: boolean;
  onRetry: (id: string) => void;
  retryingId: string | null;
}

export function SyncErrorsTable({ errors, loading, onRetry, retryingId }: SyncErrorsTableProps) {
  return (
    <div className="card card-pad">
      <h2 style={{ marginBottom: "0.75rem" }}>同期エラー</h2>
      {loading ? (
        <SkeletonRows />
      ) : errors.length === 0 ? (
        <EmptyState>未解決のエラーはありません。</EmptyState>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>発生時刻</th>
                <th>ジョブ種別</th>
                <th>商品</th>
                <th>チャネル</th>
                <th>エラー内容</th>
                <th>エラー種別</th>
                <th>対応状況</th>
                <th aria-label="アクション" />
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => {
                const copy = ERROR_CODE_LABEL[e.errorCode];
                return (
                  <tr key={e.id}>
                    <td>{relativeTime(e.createdAt)}</td>
                    <td>{e.jobType ? (JOB_TYPE_LABEL[e.jobType] ?? e.jobType) : "—"}</td>
                    <td>
                      {e.productTitle ? (
                        <>
                          {e.productTitle}
                          <div className="job-queue-sku">{e.productSku}</div>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{e.channel ? (CHANNEL_LABEL[e.channel] ?? e.channel) : "—"}</td>
                    <td>{copy?.summary ?? e.errorMessage}</td>
                    <td>
                      <Badge tone="error">{copy?.title ?? e.errorCode}</Badge>
                    </td>
                    <td>
                      <Badge tone={e.resolved ? "ok" : "warn"}>{e.resolved ? "解決済み" : "未対応"}</Badge>
                    </td>
                    <td className="job-queue-actions">
                      {!e.resolved && e.jobId && (
                        <button type="button" className="secondary" onClick={() => onRetry(e.id)} disabled={retryingId === e.id}>
                          {retryingId === e.id ? "..." : "再試行"}
                        </button>
                      )}
                      <Link href={`/sync-errors/detail?id=${e.id}`} className="secondary" style={{ display: "inline-block", textAlign: "center" }}>
                        詳細を見る
                      </Link>
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
