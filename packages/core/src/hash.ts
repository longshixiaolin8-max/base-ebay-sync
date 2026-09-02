import { createHash } from "node:crypto";

/**
 * Deterministic content hash used to detect whether a BASE-side product edit needs to be
 * re-synced (avoids re-running AI generation / eBay updates for no-op polls).
 */
export function contentHash(input: {
  title: string;
  descriptionHtml: string;
  priceJpy: number;
  images: string[];
}): string {
  const normalized = JSON.stringify({
    title: input.title,
    descriptionHtml: input.descriptionHtml,
    priceJpy: input.priceJpy,
    images: [...input.images].sort(),
  });
  return createHash("sha256").update(normalized).digest("hex");
}
