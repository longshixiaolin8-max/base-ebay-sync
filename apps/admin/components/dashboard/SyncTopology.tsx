import type { ChannelSyncState } from "@ai-ec/core";
import { relativeTime } from "@/lib/format";
import { ArrowRightIcon, BoxIcon, DatabaseIcon, TagIcon } from "@/components/icons";
import { StatusBadge } from "@/components/ui/Badge";

interface SyncTopologyProps {
  baseState: ChannelSyncState | null;
  ebayState: ChannelSyncState | null;
  productCount: number;
  totalAvailable: number;
  ebayPublishedCount: number;
  lastSyncedAt: { base: string | null; ebay: string | null };
}

/**
 * The 3-node BASE / 中央DB / eBay picture from the dashboard design. Every number shown is
 * real (products/inventory already fetched for the dashboard's other cards, ebayPublishedCount
 * and lastSyncedAt from the extended /admin/dashboard/summary), and the two edge cadence
 * labels are this platform's actual EventBridge schedules (infra/lib/lambda-stack.ts's
 * ProductFetchSchedule = 15min; eBay publish/update is SQS-driven off the product-fetch/
 * inventory-sync outbox, i.e. genuinely near-real-time, not a guessed "リアルタイム" label).
 */
export function SyncTopology({ baseState, ebayState, productCount, totalAvailable, ebayPublishedCount, lastSyncedAt }: SyncTopologyProps) {
  return (
    <div className="sync-topology">
      <TopologyNode
        icon={BoxIcon}
        title="BASE"
        subtitle="自社ストア"
        rows={[
          ["商品数", productCount.toLocaleString()],
          ["在庫数", totalAvailable.toLocaleString()],
        ]}
        state={baseState}
        lastSyncedAt={lastSyncedAt.base}
      />
      <TopologyEdge label="15分間隔" />
      <TopologyNode
        icon={DatabaseIcon}
        title="中央DB"
        subtitle="AI EC Platform"
        rows={[
          ["商品数", productCount.toLocaleString()],
          ["在庫数", totalAvailable.toLocaleString()],
        ]}
        state={null}
        lastSyncedAt={null}
        alwaysHealthy
      />
      <TopologyEdge label="リアルタイム" />
      <TopologyNode
        icon={TagIcon}
        title="eBay"
        subtitle="海外マーケット"
        rows={[
          ["出品数", ebayPublishedCount.toLocaleString()],
          ["在庫数", totalAvailable.toLocaleString()],
        ]}
        state={ebayState}
        lastSyncedAt={lastSyncedAt.ebay}
      />
    </div>
  );
}

function TopologyEdge({ label }: { label: string }) {
  return (
    <div className="sync-topology-edge">
      <ArrowRightIcon />
      <span>{label}</span>
    </div>
  );
}

function TopologyNode({
  icon: Icon,
  title,
  subtitle,
  rows,
  state,
  lastSyncedAt,
  alwaysHealthy,
}: {
  icon: typeof BoxIcon;
  title: string;
  subtitle: string;
  rows: Array<[string, string]>;
  state: ChannelSyncState | null;
  lastSyncedAt: string | null;
  alwaysHealthy?: boolean;
}) {
  return (
    <div className="sync-topology-node">
      <div className="sync-topology-node-head">
        <Icon width={18} height={18} />
        <div>
          <div className="sync-topology-node-title">{title}</div>
          <div className="sync-topology-node-subtitle">{subtitle}</div>
        </div>
      </div>
      <dl className="sync-topology-node-rows">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {alwaysHealthy ? (
        <StatusBadge state="HEALTHY" />
      ) : state ? (
        <StatusBadge state={state} />
      ) : (
        <span className="badge">確認中...</span>
      )}
      <div className="sync-topology-node-time">{lastSyncedAt ? `最終同期 ${relativeTime(lastSyncedAt)}` : "同期履歴なし"}</div>
    </div>
  );
}
