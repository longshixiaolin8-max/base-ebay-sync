import type { OrderStatus } from "@ai-ec/core";

export interface OrderProduct {
  id: string;
  sku: string;
  title: string;
  images: string[];
}

export interface OrderProfit {
  finalized: boolean;
  revenueUsdCents: number;
  costUsdCents: number;
  netProfitUsdCents: number;
  profitMarginBasisPoints: number | null;
}

export interface OrderRow {
  id: string;
  productId: string;
  channel: string;
  externalOrderId: string;
  quantity: number;
  status: OrderStatus;
  costJpy: number | null;
  salePriceJpy: number | null;
  salePriceUsdCents: number | null;
  ebayFeeUsdCents: number | null;
  paymentFeeUsdCents: number | null;
  shippingCostJpy: number | null;
  adSpendUsdCents: number | null;
  fxCostUsdCents: number | null;
  returnAmountUsdCents: number | null;
  finalizedNetProfitUsdCents: number | null;
  profitFinalizedAt: string | null;
  placedAt: string;
  paidAt: string | null;
  allocatedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  returnRequestedAt: string | null;
  returnedAt: string | null;
  refundedAt: string | null;
  product: OrderProduct | null;
  profit: OrderProfit;
  hasPossibleDoubleSale: boolean;
  belowAverageMargin: boolean;
}

export interface KpiFigure {
  value: number;
  deltaPct: number | null;
}

export interface OrdersKpi {
  orderCount: KpiFigure;
  revenueJpy: KpiFigure;
  ebayRevenueJpy: KpiFigure;
  netProfitJpy: KpiFigure;
  returnCount: { value: number; deltaAbs: number };
  profitMarginPct: { value: number | null; deltaPct: number | null };
}

export interface TrendPoint {
  date: string;
  baseRevenueJpy: number;
  ebayRevenueJpy: number;
  orderCount: number;
}

export interface ChannelBreakdown {
  revenueJpy: number;
  costJpy: number;
  feesJpy: number;
  shippingJpy: number;
  profitJpy: number;
}

export interface OrdersSummary {
  days: number;
  kpi: OrdersKpi;
  trend: TrendPoint[];
  channelBreakdown: { base: ChannelBreakdown; ebay: ChannelBreakdown };
}
