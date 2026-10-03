import type { OrderStatus } from "@ai-ec/core";
import { validNextOrderStatuses } from "@/lib/order-copy";

export interface TimelineStep {
  status: OrderStatus;
  label: string;
  /** null = not yet reached (pending) -- never a fabricated/estimated date. */
  timestamp: string | null;
}

const STEP_LABEL: Record<OrderStatus, string> = {
  ORDER_RECEIVED: "注文を受け付けました",
  PAID: "入金が確認されました",
  ALLOCATED: "発送準備をしています",
  SHIPPED: "発送しました",
  DELIVERED: "配送が完了しました",
  CANCELLED: "注文をキャンセルしました",
  RETURN_REQUESTED: "返品を受け付けました",
  RETURNED: "返品が完了しました",
  REFUNDED: "返金しました",
};

interface OrderTimestamps {
  placedAt: string;
  paidAt: string | null;
  allocatedAt: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  returnRequestedAt: string | null;
  returnedAt: string | null;
  refundedAt: string | null;
}

const TIMESTAMP_FIELD: Record<OrderStatus, keyof OrderTimestamps> = {
  ORDER_RECEIVED: "placedAt",
  PAID: "paidAt",
  ALLOCATED: "allocatedAt",
  SHIPPED: "shippedAt",
  DELIVERED: "deliveredAt",
  CANCELLED: "cancelledAt",
  RETURN_REQUESTED: "returnRequestedAt",
  RETURNED: "returnedAt",
  REFUNDED: "refundedAt",
};

const ALL_STATUSES = Object.keys(STEP_LABEL) as OrderStatus[];

/**
 * Builds the 注文タイムライン from the order row's OWN real per-status timestamp columns
 * (no dedicated order-events table exists in this schema) -- every entry with a non-null
 * timestamp genuinely happened. Appends at most one "next step" entry (no timestamp, never a
 * guessed/estimated date) for the forward-progress status this order could move to next,
 * skipping CANCELLED so a routine "could also be cancelled" option doesn't show up as the
 * headline "what's next".
 */
export function buildOrderTimeline(order: OrderTimestamps & { status: OrderStatus }): TimelineStep[] {
  const reached: TimelineStep[] = ALL_STATUSES.map((status) => ({
    status,
    label: STEP_LABEL[status],
    timestamp: order[TIMESTAMP_FIELD[status]],
  })).filter((step) => step.timestamp !== null);

  reached.sort((a, b) => new Date(a.timestamp!).getTime() - new Date(b.timestamp!).getTime());

  const nextStatus = validNextOrderStatuses(order.status).find((s) => s !== "CANCELLED");
  if (nextStatus) {
    reached.push({ status: nextStatus, label: STEP_LABEL[nextStatus], timestamp: null });
  }

  return reached;
}
