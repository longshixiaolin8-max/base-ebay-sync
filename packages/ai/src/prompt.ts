export interface SourceProductFacts {
  titleJa: string;
  descriptionJa: string;
  brand: string | null;
  material: string | null;
  sizeLabel: string | null;
  priceJpy: number;
  imageCount: number;
}

const SYSTEM_PROMPT = `You are a listing copywriter for a cross-border secondhand/apparel e-commerce
operation. You translate and adapt Japanese product listings (from BASE) into English eBay listings.

Hard rules — violating any of these makes your output unusable:
1. Only state a brand, material, size standard, or authenticity claim as "confirmed" if it is
   copied or directly translated from the source text given to you. If the source text does not
   mention it, you MUST set the corresponding confidenceFlags entry to "unknown" (if nothing at
   all is implied) or "uncertain" (if it's implied but not explicit), and you must NOT invent a
   specific value — leave the itemSpecifics field null instead of guessing.
2. You must NEVER claim "authenticity: confirmed" under any circumstance — authentication of
   branded goods is a human/verification-service task, not yours.
3. Do not upgrade your own uncertainty through confident-sounding language. If you are not sure,
   say so in reviewNotes and reflect it in confidenceFlags.
4. Pick "condition" from the source text alone -- never default to "NEW". If the source
   describes the item as vintage, used, worn, secondhand, or shows any sign of prior use,
   condition must be one of the USED_* values (choose the closest match: USED_EXCELLENT for
   barely-worn/lightly polished items, USED_VERY_GOOD for minor wear/patina typical of age,
   USED_GOOD for more visible wear, USED_ACCEPTABLE for heavy wear). Only use "NEW" when the
   source explicitly states the item is new/unused (e.g. 新品, 未使用). If the source gives no
   condition signal at all, pick your best-supported USED_* value and set confidenceFlags.condition
   to "uncertain" rather than guessing "NEW".
5. Respond with a single JSON object only, matching the required schema exactly. No prose,
   no markdown fences.`;

export function buildGenerationPrompt(product: SourceProductFacts): { system: string; user: string } {
  const user = `Source product (from BASE, in Japanese):
- Title: ${product.titleJa}
- Description: ${product.descriptionJa}
- Brand field (merchant-entered, may be empty): ${product.brand ?? "(not provided)"}
- Material field (merchant-entered, may be empty): ${product.material ?? "(not provided)"}
- Size field (merchant-entered, may be empty): ${product.sizeLabel ?? "(not provided)"}
- Price: ¥${product.priceJpy}
- Number of photos available: ${product.imageCount}

Produce a JSON object with exactly these fields:
{
  "titleEn": string (<=80 chars, eBay-style title),
  "descriptionHtmlEn": string (HTML description in English),
  "categoryCandidates": [{ "ebayCategoryId": string, "label": string }, ...] (at least 1),
  "itemSpecifics": { [aspectName: string]: string | null },
  "seoKeywords": string[],
  "suggestedPriceUsd": number | null,
  "condition": "NEW"|"LIKE_NEW"|"NEW_OTHER"|"NEW_WITH_DEFECTS"|"CERTIFIED_REFURBISHED"|"EXCELLENT_REFURBISHED"|"VERY_GOOD_REFURBISHED"|"GOOD_REFURBISHED"|"SELLER_REFURBISHED"|"USED_EXCELLENT"|"USED_VERY_GOOD"|"USED_GOOD"|"USED_ACCEPTABLE"|"FOR_PARTS_OR_NOT_WORKING"|"PRE_OWNED_EXCELLENT"|"PRE_OWNED_GOOD"|"PRE_OWNED_FAIR",
  "confidenceFlags": { "brand": "confirmed"|"uncertain"|"unknown", "material": ..., "size": ..., "authenticity": ..., "condition": ... },
  "needsHumanReview": boolean,
  "reviewNotes": string[]
}`;

  return { system: SYSTEM_PROMPT, user };
}

const INQUIRY_SYSTEM_PROMPT = `You draft reply suggestions to buyer inquiries for a cross-border
secondhand e-commerce shop. You never confirm authenticity, exact measurements, or facts not
present in the provided product/thread context. When unsure, say the seller will confirm and set
needsHumanReview to true. Respond with a single JSON object only: { "replyEn": string, "replyJa":
string, "needsHumanReview": boolean, "reviewNotes": string[] }.`;

export function buildInquiryReplyPrompt(context: {
  productTitle: string;
  productFacts: string;
  inquiryText: string;
}): { system: string; user: string } {
  return {
    system: INQUIRY_SYSTEM_PROMPT,
    user: `Product: ${context.productTitle}\nKnown facts: ${context.productFacts}\nBuyer inquiry: ${context.inquiryText}`,
  };
}

const SNS_SCRIPT_SYSTEM_PROMPT = `You write short-form video scripts (30-45 seconds, for
Instagram Reels/TikTok) for a cross-border secondhand/apparel e-commerce shop. The script
introduces one product to drive interest and sales.

Hard rules:
1. Only state a brand, material, or condition fact if it is copied or directly translated
   from the source text given to you. Never invent a fact not present in the source.
2. Never claim authenticity/authentication -- that is a human/verification-service task.
3. Keep it upbeat but honest; do not oversell or make claims about durability, rarity, or
   value the source text doesn't support.
4. Respond with a single JSON object only, matching the schema exactly. No prose, no markdown
   fences.`;

export function buildSnsScriptPrompt(product: SourceProductFacts): { system: string; user: string } {
  const user = `Source product (from BASE, in Japanese):
- Title: ${product.titleJa}
- Description: ${product.descriptionJa}
- Brand field (merchant-entered, may be empty): ${product.brand ?? "(not provided)"}
- Material field (merchant-entered, may be empty): ${product.material ?? "(not provided)"}
- Size field (merchant-entered, may be empty): ${product.sizeLabel ?? "(not provided)"}
- Price: ¥${product.priceJpy}
- Number of photos available: ${product.imageCount}

Produce a JSON object with exactly these fields:
{
  "scriptText": string (a 30-45 second spoken script, English, with brief [B-ROLL: ...] shot cues),
  "needsHumanReview": boolean,
  "reviewNotes": string[]
}`;
  return { system: SNS_SCRIPT_SYSTEM_PROMPT, user };
}

const STALE_PRODUCT_SYSTEM_PROMPT = `You suggest concrete, tactical next steps for a
secondhand/apparel product that has been listed for a long time without selling. You never
state a fact about the product you weren't given -- your suggestions are about merchandising
tactics (pricing, photos, keywords, bundling, cross-listing), never a claim about the item
itself. Respond with a single JSON object only, matching the schema exactly. No prose, no
markdown fences. Any suggested price change is only ever a suggestion -- it is never applied
automatically.`;

export function buildStaleProductSuggestionPrompt(
  product: SourceProductFacts,
  daysListed: number,
): { system: string; user: string } {
  const user = `Source product (from BASE, in Japanese), listed for ${daysListed} days without selling:
- Title: ${product.titleJa}
- Description: ${product.descriptionJa}
- Brand field (merchant-entered, may be empty): ${product.brand ?? "(not provided)"}
- Price: ¥${product.priceJpy}
- Number of photos available: ${product.imageCount}

Produce a JSON object with exactly these fields:
{
  "suggestion": string (1-2 sentences, the single most impactful next step),
  "suggestedActions": string[] (short tactical bullet points, e.g. "Cut price by 15%", "Add 2-3 more photos in natural light")
}`;
  return { system: STALE_PRODUCT_SYSTEM_PROMPT, user };
}
