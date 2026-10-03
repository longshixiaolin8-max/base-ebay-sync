/**
 * Human-readable Japanese copy for sync_jobs.type -- grepped from every real writer of that
 * column (product-fetch's insertOutboxJob, packages/db's applySaleWithOutbox), not the
 * SyncJobType zod enum in packages/core/src/sync.ts, which lists a couple of values
 * ("base_product_import", "inventory_sync") that no code path actually writes, and is
 * missing "channel_inventory_push", which is the one a real worker does write for inventory
 * pushes. This file is the ground truth for what actually shows up in the table.
 */
export const JOB_TYPE_LABEL: Record<string, string> = {
  ai_generate: "AI出品ドラフト生成",
  ebay_update: "eBay出品更新",
  channel_inventory_push: "在庫プッシュ",
};

export const JOB_STATUS_LABEL: Record<string, string> = {
  pending: "待機中",
  completed: "成功",
  failed: "失敗",
};

/**
 * sync_jobs has no channel column -- ebay_update is always eBay, channel_inventory_push
 * carries its target channel in its own payload (see packages/db/src/inventory.ts's
 * applySaleWithOutbox), and ai_generate is channel-agnostic (it only produces listing
 * content, it doesn't push to either channel). Returns null rather than guessing when the
 * payload doesn't actually say.
 */
export function jobChannel(type: string, payload: Record<string, unknown> | null | undefined): "base" | "ebay" | null {
  if (type === "ebay_update") return "ebay";
  if (type === "channel_inventory_push") {
    const channel = payload?.channel;
    return channel === "base" || channel === "ebay" ? channel : null;
  }
  return null;
}
