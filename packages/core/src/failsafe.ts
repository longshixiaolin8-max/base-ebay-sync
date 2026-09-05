export interface FinalSafetyCheckResult {
  safe: boolean;
  violations: string[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Item #3 of the third hardening round ("多段階フェイルセーフ -- AI判定→ルール判定→
 * 最終安全ルール、の3段階で誤出品を防止"). Stage 1 (AI判定) is the AI draft's own
 * generation-time guardrails (packages/ai's guardrail checks + needsHumanReview/
 * confidenceFlags); stage 2 (ルール判定) is everything already enforced earlier in
 * ebay-sync-worker's publish()/update() -- content-hash consistency, anomaly detection,
 * sync-confidence gating, required-item-specifics validation, channel isolation. This is
 * stage 3: an unconditional, hard-coded check of the *exact* payload about to be sent to
 * eBay, called right before the API call and deliberately independent of every upstream
 * gate -- so a bug in any one of them (or one not yet imagined) still can't push a listing
 * with a negative price, an empty title, or no images. Nothing here is a judgment call;
 * every rule is a plain, unconditional invariant a real listing can never violate.
 *
 * A brand-new listing (createListing) must have every field present and valid --
 * finalSafetyCheckForNewListing. An update (updateListing) only ever sends the fields that
 * changed, so finalSafetyCheckForUpdate validates only the fields actually present,
 * consistent with that partial-update-by-omission shape.
 */
export function finalSafetyCheckForNewListing(input: {
  titleEn: string;
  descriptionHtmlEn: string;
  priceUsd: number;
  quantity: number;
  images: string[];
  categoryId: string;
  condition: string;
}): FinalSafetyCheckResult {
  const violations: string[] = [];
  if (!isNonEmptyString(input.titleEn)) violations.push("title is empty");
  if (!isNonEmptyString(input.descriptionHtmlEn)) violations.push("description is empty");
  if (!(input.priceUsd > 0)) violations.push(`price is not a positive number (${input.priceUsd})`);
  if (!(input.quantity >= 0)) violations.push(`quantity is negative (${input.quantity})`);
  if (!input.images || input.images.length === 0) violations.push("no images");
  if (!isNonEmptyString(input.categoryId)) violations.push("no category");
  if (!isNonEmptyString(input.condition)) violations.push("no condition");
  return { safe: violations.length === 0, violations };
}

export function finalSafetyCheckForUpdate(input: {
  titleEn?: string;
  descriptionHtmlEn?: string;
  priceUsd?: number;
  quantity?: number;
  images?: string[];
  condition?: string;
}): FinalSafetyCheckResult {
  const violations: string[] = [];
  if (input.titleEn !== undefined && !isNonEmptyString(input.titleEn)) violations.push("title is empty");
  if (input.descriptionHtmlEn !== undefined && !isNonEmptyString(input.descriptionHtmlEn)) {
    violations.push("description is empty");
  }
  if (input.priceUsd !== undefined && !(input.priceUsd > 0)) {
    violations.push(`price is not a positive number (${input.priceUsd})`);
  }
  if (input.quantity !== undefined && !(input.quantity >= 0)) violations.push(`quantity is negative (${input.quantity})`);
  if (input.images !== undefined && input.images.length === 0) violations.push("images list is empty");
  if (input.condition !== undefined && !isNonEmptyString(input.condition)) violations.push("condition is empty");
  return { safe: violations.length === 0, violations };
}
