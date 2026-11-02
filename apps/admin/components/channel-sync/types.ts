import type { ChannelSyncState } from "@ai-ec/core";

export interface ConnectionDetail {
  connected: boolean;
  externalAccountId: string | null;
  expiresAt: string | null;
  lastSyncedAt: string | null;
  state: ChannelSyncState;
  reasons: string[];
}

export interface ConnectionsResponse {
  base: ConnectionDetail;
  ebay: ConnectionDetail;
  // The real GET /admin/sync/connections response now includes shopify too (see
  // CHANNEL_META/DISPLAYED_CHANNELS) -- this page's own KPI cards/ConnectionCards/
  // IsolationCard still only render base/ebay explicitly (a pre-existing, not-yet-
  // array-driven duplicate of Settings > 接続; see docs/adding-a-channel.md), so shopify
  // is typed here but intentionally unused by this page today.
  shopify: ConnectionDetail;
}

export interface SyncJobRow {
  id: string;
  type: string;
  productId: string | null;
  productTitle: string | null;
  productSku: string | null;
  status: "pending" | "completed" | "failed";
  attempts: number;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SyncJobCounts {
  all: number;
  pending: number;
  completed: number;
  failed: number;
}

export interface SyncErrorRow {
  id: string;
  jobId: string | null;
  channel: string | null;
  productId: string | null;
  errorCode: string;
  errorMessage: string;
  payload: Record<string, unknown> | null;
  resolved: boolean;
  createdAt: string;
  productTitle: string | null;
  productSku: string | null;
  jobType: string | null;
}

export interface PipelineStage {
  count: number;
  pending?: number;
}

export interface PipelineResponse {
  from: string;
  to: string;
  fetched: PipelineStage;
  transformed: PipelineStage;
  published: PipelineStage;
}
