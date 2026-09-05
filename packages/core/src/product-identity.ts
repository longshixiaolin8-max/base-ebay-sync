export interface ProductIdentityCandidate {
  productId: string;
  title: string;
  brand?: string | null;
  material?: string | null;
  sizeLabel?: string | null;
}

export interface ProductIdentityMatch {
  productId: string;
  score: number;
  reasons: string[];
}

const TITLE_WEIGHT = 60;
const BRAND_WEIGHT = 15;
const MATERIAL_WEIGHT = 15;
const SIZE_WEIGHT = 10;
/** A match is only ever a suggestion for a human to confirm (see link-ebay-listing) --
 *  never auto-linked -- so this stays conservative: title similarity alone needs to be
 *  quite high (>= ~83%) to clear it on its own. */
export const IDENTITY_MATCH_THRESHOLD = 50;

function normalizeTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

/** Jaccard similarity of the two titles' word sets: |intersection| / |union|. A real,
 *  literal token-overlap measure -- never a fuzzy guess dressed up as a score. */
function titleSimilarity(a: string, b: string): number {
  const tokensA = normalizeTokens(a);
  const tokensB = normalizeTokens(b);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection += 1;
  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function exactMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Item #5 of the third hardening round ("自動商品同一性判定 -- SKUだけでなく、画像・商品名・
 * 型番・特徴量で同一商品を判定"). Starts from title + brand/material/size text attributes,
 * not images: this platform has no image-embedding model provisioned anywhere, and a
 * fabricated similarity score dressed up as "image matching" would be worse than none.
 * An exact brand/material/size match is real corroborating evidence on top of title
 * similarity, not just more of the same signal, so each is its own weighted bonus rather
 * than folded into one blended score.
 *
 * Used by /admin/ebay/unmanaged-listings to suggest which existing product an eBay listing
 * with no deterministic SKU match might actually be -- always a suggestion, never an
 * automatic link (see link-ebay-listing, still a human-triggered action).
 */
export function matchProductIdentity(
  candidate: { title: string; brand?: string | null; material?: string | null; sizeLabel?: string | null },
  products: ProductIdentityCandidate[],
): ProductIdentityMatch[] {
  const matches: ProductIdentityMatch[] = [];

  for (const product of products) {
    const reasons: string[] = [];
    const titleSim = titleSimilarity(candidate.title, product.title);
    let score = titleSim * TITLE_WEIGHT;
    if (titleSim > 0) reasons.push(`title similarity ${Math.round(titleSim * 100)}%`);

    if (exactMatch(candidate.brand, product.brand)) {
      score += BRAND_WEIGHT;
      reasons.push(`brand matches (${product.brand})`);
    }
    if (exactMatch(candidate.material, product.material)) {
      score += MATERIAL_WEIGHT;
      reasons.push(`material matches (${product.material})`);
    }
    if (exactMatch(candidate.sizeLabel, product.sizeLabel)) {
      score += SIZE_WEIGHT;
      reasons.push(`size matches (${product.sizeLabel})`);
    }

    const roundedScore = Math.round(score);
    if (roundedScore >= IDENTITY_MATCH_THRESHOLD) {
      matches.push({ productId: product.productId, score: roundedScore, reasons });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}
