/**
 * Japanese labels/tones for GET /admin/products/list's per-row `diffStatus.code`. The codes
 * themselves come from admin-api's own classification (see handler.ts's GET /admin/products/list
 * and @ai-ec/core's classifyInventoryDiffMagnitude) -- this is purely display copy, kept out of
 * the frontend's own duplication of that logic since the backend already does the classifying
 * and only ever emits these 4 strings.
 */
export const DIFF_STATUS_LABEL: Record<string, string> = {
  normal: "正常",
  attention: "要確認",
  possible_double_sale: "possible_double_sale",
  sold_out: "売り切れ",
};

export const DIFF_STATUS_TONE: Record<string, "ok" | "warn" | "error" | "neutral"> = {
  normal: "ok",
  attention: "warn",
  possible_double_sale: "error",
  sold_out: "neutral",
};

export function diffLabel(code: string, diff: number | null): string {
  if (code === "possible_double_sale") return "possible_double_sale";
  if (code === "sold_out") return "在庫0";
  if (diff === null) return "—";
  return diff === 0 ? "差分 0" : `差分 ${diff > 0 ? "+" : ""}${diff}`;
}
