/**
 * Shared copy for AI listing draft review UI (products/detail's diagnostics panel and the
 * dedicated AI出品下書き page). confidenceFlags' field keys are whatever the AI generation
 * prompt (packages/ai) actually emits -- grepped from there, not guessed.
 *
 * draftConfidenceScore is deliberately duplicated from @ai-ec/core (which admin-api's own
 * GET /admin/drafts imports the real one from) rather than imported here -- same reason
 * lib/order-copy.ts already duplicates its own small piece of @ai-ec/core logic instead of
 * importing it: @ai-ec/core's barrel export also pulls in hash.ts (node:crypto), which
 * breaks the Next.js client bundle (confirmed live: `next build` fails on
 * "node:crypto ... Unhandled scheme" the moment anything here imports a runtime value, not
 * just a type, from "@ai-ec/core"). Keep this in sync with packages/core/src/ai.ts's copy
 * if the formula ever changes.
 */
export function draftConfidenceScore(confidenceFlags: Record<string, string>): number {
  const values = Object.values(confidenceFlags);
  if (values.length === 0) return 100;
  const confirmed = values.filter((v) => v === "confirmed").length;
  return Math.round((confirmed / values.length) * 100);
}

/** Duplicated from @ai-ec/core's ItemCondition enum (packages/core/src/ai.ts) for the exact
 *  same node:crypto/barrel-export reason as draftConfidenceScore above -- POST
 *  /admin/products/{id}/draft-condition validates against this same real eBay
 *  ConditionEnum list server-side, so any value from here is guaranteed valid. Keep in sync
 *  with the source enum if it ever changes. */
export const EBAY_ITEM_CONDITIONS = [
  "NEW",
  "LIKE_NEW",
  "NEW_OTHER",
  "NEW_WITH_DEFECTS",
  "CERTIFIED_REFURBISHED",
  "EXCELLENT_REFURBISHED",
  "VERY_GOOD_REFURBISHED",
  "GOOD_REFURBISHED",
  "SELLER_REFURBISHED",
  "USED_EXCELLENT",
  "USED_VERY_GOOD",
  "USED_GOOD",
  "USED_ACCEPTABLE",
  "FOR_PARTS_OR_NOT_WORKING",
  "PRE_OWNED_EXCELLENT",
  "PRE_OWNED_GOOD",
  "PRE_OWNED_FAIR",
] as const;

export const CONFIDENCE_LABEL: Record<string, string> = { confirmed: "確認済み", uncertain: "未確認", unknown: "不明" };

export const FIELD_LABEL_JA: Record<string, string> = {
  brand: "ブランド",
  material: "素材",
  size: "サイズ",
  authenticity: "真贋",
  condition: "状態",
};
