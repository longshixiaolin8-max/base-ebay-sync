import { z } from "zod";
import { ChannelType } from "./channel.js";

export const SyncJobType = z.enum([
  "base_product_import",
  "ai_generate",
  "ebay_publish",
  "ebay_update",
  "inventory_sync",
]);
export type SyncJobType = z.infer<typeof SyncJobType>;

export const SyncJobStatus = z.enum(["pending", "processing", "succeeded", "failed"]);
export type SyncJobStatus = z.infer<typeof SyncJobStatus>;

export const SyncJob = z.object({
  id: z.string().uuid(),
  type: SyncJobType,
  idempotencyKey: z.string().min(1),
  productId: z.string().uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: SyncJobStatus,
  attempts: z.number().int().nonnegative(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type SyncJob = z.infer<typeof SyncJob>;

export const SyncError = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  channel: ChannelType.nullable(),
  productId: z.string().uuid().nullable(),
  errorCode: z.string(),
  errorMessage: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  resolved: z.boolean(),
  createdAt: z.coerce.date(),
});
export type SyncError = z.infer<typeof SyncError>;

export const AuditLogEntry = z.object({
  id: z.string().uuid(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.coerce.date(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;
