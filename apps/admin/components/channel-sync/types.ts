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
