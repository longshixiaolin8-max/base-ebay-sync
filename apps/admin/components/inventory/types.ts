export interface InventoryBreakdown {
  productId: string;
  onHand: number;
  reserved: number;
  available: number;
  safetyBuffer: number;
  sellableByChannel: Record<string, number>;
}

export interface InventoryProductRow {
  id: string;
  sku: string;
  title: string;
  sourceChannel: string;
  status: string;
  images: string[];
  priceJpy: number;
  costJpy: number | null;
  ebayListingStatus: string | null;
  inventory: InventoryBreakdown | null;
  safetyStockBuffer: number;
  diffStatus: { code: string; diff: number | null };
  lastSyncedAt: string | null;
  aiDraftCount: number;
  updatedAt: string;
}

export interface InventoryKpi {
  monitored: number;
  diffCount: number;
  safetyStockAppliedCount: number;
  possibleDoubleSaleCount: number;
  reconstructPendingCount: number;
  syncedRate: number;
}

export interface ChannelHealthBucket {
  normal: number;
  safetyStock: number;
  drift: number;
  possibleDoubleSale: number;
  soldOut: number;
  total: number;
}

export interface InventoryHealthByChannel {
  base: ChannelHealthBucket;
  ebay: ChannelHealthBucket;
  central: ChannelHealthBucket;
}

export interface InventoryTrendPoint {
  date: string;
  diffCount: number;
  possibleDoubleSaleCount: number;
}

export interface ProductDetail {
  product: { id: string; title: string; sku: string; images: string[]; sourceChannel: string };
  listings: Array<{ channel: string; status: string; externalId: string | null; lastSyncedAt: string | null }>;
  inventory: InventoryBreakdown | null;
  draft: { categoryCandidates: Array<{ ebayCategoryId: string; label: string }> } | null;
}

export interface SyncTraceEntry {
  source: "inventory_event" | "audit_log" | "sync_error";
  occurredAt: string;
  summary: string;
  detail: Record<string, unknown>;
}

export interface SyncErrorRow {
  id: string;
  errorCode: string;
  channel: string | null;
  resolved: boolean;
  createdAt: string;
}
