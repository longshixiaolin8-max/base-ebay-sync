import { AIGeneratedListing, type AIGeneratedListing as AIGeneratedListingT } from "@ai-ec/core";
import { z } from "zod";
import type { SourceProductFacts } from "./prompt.js";

export class AIOutputValidationError extends Error {
  constructor(readonly cause: z.ZodError) {
    super(`AI output did not match the required schema: ${cause.message}`);
    this.name = "AIOutputValidationError";
  }
}

/**
 * Parses and enforces the AI's output contract. This is the code — not the prompt —
 * that guarantees the "never fabricate brand/material/size/authenticity" requirement,
 * because prompts alone cannot be trusted to bound a model's behavior.
 *
 * Rules enforced here, independent of what the model claims:
 *  - "authenticity: confirmed" is never accepted from the model — authentication is a
 *    human/verification-service task. Always downgraded to "uncertain".
 *  - "confirmed" for brand/material/size is only accepted when the *source* BASE product
 *    actually had that field populated. If the merchant never entered a brand, the model
 *    cannot claim to have confirmed one — it is downgraded to "unknown" and the
 *    corresponding itemSpecifics entry is nulled out.
 *  - needsHumanReview is forced to true whenever any confidence flag is not "confirmed".
 */
export function enforceGuardrails(raw: unknown, source: SourceProductFacts): AIGeneratedListingT {
  const parseResult = AIGeneratedListing.safeParse(raw);
  if (!parseResult.success) {
    throw new AIOutputValidationError(parseResult.error);
  }
  const parsed = parseResult.data;

  const flags = { ...parsed.confidenceFlags };
  const notes = [...parsed.reviewNotes];
  const itemSpecifics = { ...parsed.itemSpecifics };

  if (flags.authenticity === "confirmed") {
    flags.authenticity = "uncertain";
    notes.push("Authenticity cannot be AI-confirmed; downgraded to uncertain pending human/verification review.");
  }

  const factChecks: Array<{ field: "brand" | "material" | "size"; sourceValue: string | null; specificsKey: string }> = [
    { field: "brand", sourceValue: source.brand, specificsKey: "Brand" },
    { field: "material", sourceValue: source.material, specificsKey: "Material" },
    { field: "size", sourceValue: source.sizeLabel, specificsKey: "Size" },
  ];

  for (const check of factChecks) {
    if (check.sourceValue === null && flags[check.field] === "confirmed") {
      flags[check.field] = "unknown";
      itemSpecifics[check.specificsKey] = null;
      notes.push(
        `Source product had no ${check.field} field but AI marked it "confirmed"; downgraded to "unknown" and cleared the value.`,
      );
    }
  }

  const needsHumanReview =
    parsed.needsHumanReview || Object.values(flags).some((level) => level !== "confirmed");

  return {
    ...parsed,
    itemSpecifics,
    confidenceFlags: flags,
    needsHumanReview,
    reviewNotes: notes,
  };
}
