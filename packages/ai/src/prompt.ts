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
4. Respond with a single JSON object only, matching the required schema exactly. No prose,
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
  "confidenceFlags": { "brand": "confirmed"|"uncertain"|"unknown", "material": ..., "size": ..., "authenticity": ... },
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
