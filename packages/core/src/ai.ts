import { z } from "zod";

/**
 * Confidence level for a factual claim the AI is not equipped to verify on its own
 * (brand authenticity, material composition, exact size standard, ...).
 *
 * The AI must NEVER silently assert a fact it cannot verify from the source text/images.
 * "confirmed" is only allowed when the claim is copied verbatim from BASE's own product
 * data (i.e. the merchant already stated it) — the AI is not permitted to upgrade an
 * "unknown" to "confirmed" by inference or guesswork.
 */
export const ConfidenceLevel = z.enum(["confirmed", "uncertain", "unknown"]);
export type ConfidenceLevel = z.infer<typeof ConfidenceLevel>;

export const AIConfidenceFlags = z.object({
  brand: ConfidenceLevel,
  material: ConfidenceLevel,
  size: ConfidenceLevel,
  authenticity: ConfidenceLevel,
  condition: ConfidenceLevel,
});
export type AIConfidenceFlags = z.infer<typeof AIConfidenceFlags>;

/**
 * eBay's own Sell Inventory API condition enum (ConditionEnum). Reusing eBay's own
 * defined values here isn't guessing a fact about the product -- the model still has to
 * pick which one the source text actually supports (see the prompt's condition rule) --
 * it's just naming the closed set of values the downstream createListing/updateListing
 * call is allowed to send.
 */
export const ItemCondition = z.enum([
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
  // eBay's newer 3-tier "pre-owned" grading scale used by fashion/jewelry categories
  // instead of the generic USED_* scale above (confirmed live via
  // EbayAdapter.getConditionPolicies -- category 262003 only accepts these plus NEW*).
  "PRE_OWNED_EXCELLENT",
  "PRE_OWNED_GOOD",
  "PRE_OWNED_FAIR",
]);
export type ItemCondition = z.infer<typeof ItemCondition>;

/**
 * Structured output the AI generation service must produce. Any field the model is not
 * confident about must be null with the matching confidenceFlags entry set to "uncertain"
 * or "unknown" — never a fabricated guess. See packages/ai/src/guardrail.ts for the
 * validation that enforces this contract at runtime.
 */
export const AIGeneratedListing = z.object({
  titleEn: z.string().min(1).max(80),
  descriptionHtmlEn: z.string().min(1),
  categoryCandidates: z.array(z.object({ ebayCategoryId: z.string(), label: z.string() })).min(1),
  itemSpecifics: z.record(z.string(), z.string().nullable()),
  seoKeywords: z.array(z.string()).default([]),
  suggestedPriceUsd: z.number().positive().nullable(),
  /** Must be derived from what the source text actually says; see guardrail.ts. */
  condition: ItemCondition,
  confidenceFlags: AIConfidenceFlags,
  /** True whenever any confidenceFlags entry is not "confirmed" — forces human review. */
  needsHumanReview: z.boolean(),
  reviewNotes: z.array(z.string()).default([]),
});
export type AIGeneratedListing = z.infer<typeof AIGeneratedListing>;

/**
 * Consistency check between an AI-drafted listing's itemSpecifics and eBay's real,
 * per-category required aspects (fetched live via EbayAdapter.getRequiredItemAspects —
 * never guessed). A missing aspect here means an eBay publish attempt is *known* to fail
 * before spending the API call on it, rather than surfacing only as a live 400.
 */
export function findMissingRequiredAspects(
  itemSpecifics: Record<string, string | null>,
  requiredAspectNames: string[],
): string[] {
  return requiredAspectNames.filter((name) => !itemSpecifics[name]);
}

export const InquiryReplyDraft = z.object({
  replyEn: z.string().min(1),
  replyJa: z.string().min(1),
  needsHumanReview: z.boolean(),
  reviewNotes: z.array(z.string()).default([]),
});
export type InquiryReplyDraft = z.infer<typeof InquiryReplyDraft>;

/**
 * Item #6 of the commercial-features round ("SNS管理" -- AI台本生成). A short-video script
 * only -- this platform has no video-generation or social-posting integration, so the script
 * is always a human-reviewed draft a person actually records/posts from (see
 * @ai-ec/db's sns-content.ts markSnsStatus for the human-confirmed posting flags).
 */
export const SnsScriptDraft = z.object({
  scriptText: z.string().min(1),
  needsHumanReview: z.boolean(),
  reviewNotes: z.array(z.string()).default([]),
});
export type SnsScriptDraft = z.infer<typeof SnsScriptDraft>;

/**
 * Item #5 of the commercial-features round ("滞留商品管理" -- AI改善提案). A tactical
 * suggestion only (e.g. "price cut", "reshoot photos") -- never a fact about the product
 * itself, and never auto-applied: any resulting price change or re-listing still goes through
 * this platform's existing human-approval gates (see ebay-sync-worker's publish()/update()).
 */
export const StaleProductSuggestion = z.object({
  suggestion: z.string().min(1),
  suggestedActions: z.array(z.string()).default([]),
});
export type StaleProductSuggestion = z.infer<typeof StaleProductSuggestion>;
