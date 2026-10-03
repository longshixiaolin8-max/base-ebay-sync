import { Drawer } from "@/components/ui/Drawer";
import { JOB_STATUS_LABEL, JOB_TYPE_LABEL } from "@/lib/sync-job-copy";
import type { SyncJobRow } from "./types";

export function JobDetailDrawer({ job, onClose }: { job: SyncJobRow | null; onClose: () => void }) {
  return (
    <Drawer open={job !== null} onClose={onClose} title="同期ジョブの詳細">
      {job && (
        <div className="job-detail-drawer">
          <dl className="job-detail-rows">
            <div>
              <dt>ジョブ種別</dt>
              <dd>{JOB_TYPE_LABEL[job.type] ?? job.type}</dd>
            </div>
            <div>
              <dt>商品</dt>
              <dd>{job.productTitle ? `${job.productTitle}(${job.productSku})` : "—"}</dd>
            </div>
            <div>
              <dt>ステータス</dt>
              <dd>{JOB_STATUS_LABEL[job.status] ?? job.status}</dd>
            </div>
            <div>
              <dt>試行回数</dt>
              <dd>{job.attempts}</dd>
            </div>
            <div>
              <dt>Idempotency Key</dt>
              <dd className="job-detail-key">{job.idempotencyKey}</dd>
            </div>
            <div>
              <dt>作成日時</dt>
              <dd>{new Date(job.createdAt).toLocaleString("ja-JP")}</dd>
            </div>
            <div>
              <dt>更新日時</dt>
              <dd>{new Date(job.updatedAt).toLocaleString("ja-JP")}</dd>
            </div>
          </dl>
          <div className="section-eyebrow">ペイロード</div>
          <pre className="job-detail-payload">{JSON.stringify(job.payload, null, 2)}</pre>
        </div>
      )}
    </Drawer>
  );
}
