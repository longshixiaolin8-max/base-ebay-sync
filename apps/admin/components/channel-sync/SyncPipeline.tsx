import { ArrowRightIcon, BoxIcon, DatabaseIcon, TagIcon } from "@/components/icons";
import type { PipelineResponse } from "./types";

interface SyncPipelineProps {
  data: PipelineResponse | null;
}

/**
 * The BASE -> 取得 -> 中央DB -> 変換 -> eBay -> 公開 flow, distinct from the dashboard's
 * SyncTopology (that one is a live inventory/product-count snapshot; this one is "how much
 * real work moved through each stage in the selected period" -- every number is a real count
 * over existing tables, see GET /admin/sync/pipeline's own comments for exactly which query
 * backs which stage). 取得 has no real "pending" concept (BASE import runs synchronously per
 * poll, not through a queue), so its node simply omits that line rather than showing a fake 0.
 */
export function SyncPipeline({ data }: SyncPipelineProps) {
  return (
    <div className="sync-pipeline">
      <PipelineNode icon={BoxIcon} title="BASE" subtitle="自社ストア" />
      <PipelineEdge label="取得ジョブ" count={data?.fetched.count} />
      <PipelineNode icon={DatabaseIcon} title="中央DB" subtitle="AI EC Platform" />
      <PipelineEdge label="変換ジョブ" count={data?.transformed.count} pending={data?.transformed.pending} />
      <PipelineNode icon={TagIcon} title="eBay" subtitle="海外マーケット" />
      <PipelineEdge label="公開ジョブ" count={data?.published.count} pending={data?.published.pending} />
    </div>
  );
}

function PipelineNode({ icon: Icon, title, subtitle }: { icon: typeof BoxIcon; title: string; subtitle: string }) {
  return (
    <div className="pipeline-node">
      <Icon width={20} height={20} />
      <div>
        <div className="pipeline-node-title">{title}</div>
        <div className="pipeline-node-subtitle">{subtitle}</div>
      </div>
    </div>
  );
}

function PipelineEdge({ label, count, pending }: { label: string; count?: number; pending?: number }) {
  return (
    <div className="pipeline-edge">
      <ArrowRightIcon />
      <div className="pipeline-edge-label">{label}</div>
      <div className="pipeline-edge-count">{count ?? "—"}</div>
      {pending !== undefined && pending > 0 && <div className="pipeline-edge-pending">処理待ち {pending}件</div>}
    </div>
  );
}
