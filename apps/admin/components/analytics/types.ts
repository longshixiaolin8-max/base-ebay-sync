export interface KpiFigure {
  value: number | null;
  deltaPct: number | null;
}

export interface AnalyticsKpi {
  monthlyRevenueJpy: KpiFigure;
  monthlyProfitJpy: KpiFigure;
  ebayListingConversionRate: KpiFigure;
  turnoverRate: KpiFigure;
  syncSuccessRate: KpiFigure;
  aiDraftApprovalRate: KpiFigure;
}

export interface TrendPoint {
  period: string;
  totalRevenueJpy: number;
  baseRevenueJpy: number;
  ebayRevenueJpy: number;
}

export interface ChannelByMonth {
  month: string;
  baseRevenueJpy: number;
  ebayRevenueJpy: number;
}

export interface ProfitWaterfall {
  revenueJpy: number;
  costJpy: number;
  feesJpy: number;
  shippingJpy: number;
  profitJpy: number;
}

export interface CategoryRevenue {
  category: string;
  revenueJpy: number;
}

export interface TurnoverHeatmapData {
  weeks: string[];
  categories: string[];
  cells: number[][];
}

export interface Funnel {
  generated: number;
  published: number;
  ordered: number;
}

export interface Insight {
  tone: "info" | "warn" | "ok";
  message: string;
}

export interface AnalyticsSummary {
  days: number;
  granularity: "daily" | "weekly" | "monthly";
  kpi: AnalyticsKpi;
  trend: TrendPoint[];
  channelByMonth: ChannelByMonth[];
  profitWaterfall: ProfitWaterfall;
  categoryRevenue: CategoryRevenue[];
  turnoverHeatmap: TurnoverHeatmapData;
  funnel: Funnel;
  insights: Insight[];
}

export interface RankedProduct {
  productId: string;
  title: string | null;
  sku: string | null;
  images: string[];
  revenueJpy: number;
  profitJpy: number;
  orderCount: number;
  turnoverRate: number | null;
  syncConfidenceScore: number;
}
