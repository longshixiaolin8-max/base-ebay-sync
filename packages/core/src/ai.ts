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
});
export type AIConfidenceFlags = z.infer<typeof AIConfidenceFlags>;

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
  confidenceFlags: AIConfidenceFlags,
  /** True whenever any confidenceFlags entry is not "confirmed" — forces human review. */
  needsHumanReview: z.boolean(),
  reviewNotes: z.array(z.string()).default([]),
});
export type AIGeneratedListing = z.infer<typeof AIGeneratedListing>;

export const InquiryReplyDraft = z.object({
  replyEn: z.string().min(1),
  replyJa: z.string().min(1),
  needsHumanReview: z.boolean(),
  reviewNotes: z.array(z.string()).default([]),
});
export type InquiryReplyDraft = z.infer<typeof InquiryReplyDraft>;
