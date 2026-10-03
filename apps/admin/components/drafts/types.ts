export interface DraftListItem {
  id: string;
  productId: string;
  title: string;
  sku: string;
  images: string[];
  categoryLabel: string | null;
  confidenceScore: number;
  needsHumanReview: boolean;
  sourceMismatch: boolean;
  createdAt: string;
}

export interface DraftsKpi {
  reviewPending: number;
  needsFix: number;
  publishedToday: number;
  avgConfidence: number;
}

export interface ProductDetailRow {
  id: string;
  sku: string;
  title: string;
  descriptionJa: string;
  brand: string | null;
  material: string | null;
  sizeLabel: string | null;
  priceJpy: number;
  images: string[];
  status: string;
  costJpy: number | null;
  sourceChannel: string;
  contentHash: string;
}

export interface ChannelListingRow {
  channel: string;
  status: string;
  externalId: string | null;
  lastSyncedAt: string | null;
}

export interface AiListingDraftRow {
  id: string;
  titleEn: string;
  descriptionHtmlEn: string;
  categoryCandidates: Array<{ ebayCategoryId: string; label: string }>;
  itemSpecifics: Record<string, string | null>;
  seoKeywords: string[];
  /** Cents, despite the name -- see services/lambdas/admin-api's own comment on this same
   *  pre-existing column. Divide by 100 for display. */
  suggestedPriceUsd: number | null;
  condition: string;
  confidenceFlags: Record<string, string>;
  needsHumanReview: boolean;
  reviewNotes: string[];
  internalNotes: string | null;
  sourceContentHash: string;
  createdAt: string;
}

export interface InventoryBreakdown {
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

export interface DynamicPrice {
  recommendedPriceUsd: number;
  netMarginRatio: number;
  costMarkupRatio: number;
  fxRateUsdPerJpy: number;
}

export interface PreflightCheck {
  categoryId: string | null;
  missingAspects: string[];
}
