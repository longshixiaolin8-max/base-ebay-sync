import { z } from "zod";

/**
 * Item #1 of the commercial-features round ("正式なOrderモデルを追加"). One row per
 * (channel, external order id, product) -- matching the granularity inventory-sync-worker
 * already processes sales at (see processSale) -- tracked through to profit realization.
 *
 * CANCELLED/REFUNDED are terminal; RETURN_REQUESTED/RETURNED/REFUNDED model a return that
 * can start from either SHIPPED or DELIVERED (a carrier can lose a package before delivery
 * is even confirmed).
 */
export const OrderStatus = z.enum([
  "ORDER_RECEIVED",
  "PAID",
  "ALLOCATED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
  "RETURN_REQUESTED",
  "RETURNED",
  "REFUNDED",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

const ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  ORDER_RECEIVED: ["PAID", "CANCELLED"],
  PAID: ["ALLOCATED", "CANCELLED"],
  ALLOCATED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED", "RETURN_REQUESTED"],
  DELIVERED: ["RETURN_REQUESTED"],
  CANCELLED: [],
  RETURN_REQUESTED: ["RETURNED"],
  RETURNED: ["REFUNDED"],
  REFUNDED: [],
};

/**
 * Server-side guard against an illegal jump (e.g. ORDER_RECEIVED -> SHIPPED, or resurrecting
 * a CANCELLED order) -- every status-changing admin action calls this before writing, so a
 * bad request 400s instead of corrupting the order's history.
 */
export function isValidOrderTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** True once an order can no longer change status. */
export function isTerminalOrderStatus(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** Wire shape of an orders row, for admin-api responses and the admin frontend. */
export const Order = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  channel: z.string(),
  externalOrderId: z.string(),
  quantity: z.number().int().positive(),
  status: OrderStatus,
  costJpy: z.number().int().nullable(),
  salePriceJpy: z.number().int().nullable(),
  salePriceUsdCents: z.number().int().nullable(),
  ebayFeeUsdCents: z.number().int().nullable(),
  paymentFeeUsdCents: z.number().int().nullable(),
  shippingCostJpy: z.number().int().nullable(),
  adSpendUsdCents: z.number().int().nullable(),
  fxCostUsdCents: z.number().int().nullable(),
  returnAmountUsdCents: z.number().int().nullable(),
  finalizedNetProfitUsdCents: z.number().int().nullable(),
  profitFinalizedAt: z.coerce.date().nullable(),
  placedAt: z.coerce.date(),
  paidAt: z.coerce.date().nullable(),
  allocatedAt: z.coerce.date().nullable(),
  shippedAt: z.coerce.date().nullable(),
  deliveredAt: z.coerce.date().nullable(),
  cancelledAt: z.coerce.date().nullable(),
  returnRequestedAt: z.coerce.date().nullable(),
  returnedAt: z.coerce.date().nullable(),
  refundedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Order = z.infer<typeof Order>;
