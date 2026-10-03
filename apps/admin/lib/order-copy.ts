import type { OrderStatus } from "@ai-ec/core";

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  ORDER_RECEIVED: "受注",
  PAID: "入金済み",
  ALLOCATED: "引当済み",
  SHIPPED: "発送済み",
  DELIVERED: "配達完了",
  CANCELLED: "キャンセル",
  RETURN_REQUESTED: "返品申請中",
  RETURNED: "返品完了",
  REFUNDED: "返金済み",
};

/** Badge color class (see globals.css's .badge variants) for each order status. */
export const ORDER_STATUS_BADGE: Record<OrderStatus, string> = {
  ORDER_RECEIVED: "badge warn",
  PAID: "badge",
  ALLOCATED: "badge",
  SHIPPED: "badge ok",
  DELIVERED: "badge ok",
  CANCELLED: "badge error",
  RETURN_REQUESTED: "badge warn",
  RETURNED: "badge error",
  REFUNDED: "badge error",
};

/**
 * Mirrors @ai-ec/order.ts's own ALLOWED_TRANSITIONS exactly (the source of truth the backend
 * actually enforces) -- duplicated here, rather than imported, because @ai-ec/core's barrel
 * also re-exports hash.ts (node:crypto), which Next.js's client bundle can't resolve. Both
 * sides are pure data with no reason to diverge; a change to one must be mirrored in the other.
 */
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

export function validNextOrderStatuses(status: OrderStatus): OrderStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

export function isOrderStatusTerminal(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
