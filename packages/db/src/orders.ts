import { computeOrderProfit, isValidOrderTransition, type OrderProfitInputs, type OrderProfitResult, type OrderStatus } from "@ai-ec/core";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { orders } from "./schema.js";

export type OrderRow = typeof orders.$inferSelect;

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot transition order from ${from} to ${to}`);
    this.name = "InvalidOrderTransitionError";
  }
}

export interface UpsertOrderReceivedInput {
  productId: string;
  channel: string;
  externalOrderId: string;
  quantity: number;
  placedAt: Date;
  /** Snapshot of product_master.cost_jpy at sale time -- callers look this up themselves so
   *  this function stays a single-table write, matching this codebase's no-join style. */
  costJpy?: number | null;
  salePriceJpy?: number | null;
  salePriceUsdCents?: number | null;
}

/**
 * Item #1 of the commercial-features round ("正式なOrderモデルを追加"). Idempotent on
 * (channel, external_order_id, product_id) -- a duplicate delivery of the same sale event
 * (the same real-world case applySale's CAS/withIdempotency already guard against) is a
 * no-op here too, and never overwrites an order that has already progressed past
 * ORDER_RECEIVED. This is a bookkeeping record alongside applySale, never a replacement for
 * it -- callers call both, and this one is never allowed to block or fail the caller's own
 * inventory-critical path (see inventory-sync-worker's processSale).
 */
export async function upsertOrderReceived(db: Database, input: UpsertOrderReceivedInput): Promise<OrderRow> {
  await db
    .insert(orders)
    .values({
      productId: input.productId,
      channel: input.channel,
      externalOrderId: input.externalOrderId,
      quantity: input.quantity,
      status: "ORDER_RECEIVED",
      placedAt: input.placedAt,
      costJpy: input.costJpy ?? null,
      salePriceJpy: input.salePriceJpy ?? null,
      salePriceUsdCents: input.salePriceUsdCents ?? null,
    })
    .onConflictDoNothing({ target: [orders.channel, orders.externalOrderId, orders.productId] });

  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.channel, input.channel), eq(orders.externalOrderId, input.externalOrderId), eq(orders.productId, input.productId)))
    .limit(1);
  if (!row) {
    throw new Error(`orders row missing immediately after upsert for ${input.channel}/${input.externalOrderId}/${input.productId}`);
  }
  return row;
}

function statusTimestampPatch(status: OrderStatus, now: Date): Partial<typeof orders.$inferInsert> {
  switch (status) {
    case "PAID":
      return { paidAt: now };
    case "ALLOCATED":
      return { allocatedAt: now };
    case "SHIPPED":
      return { shippedAt: now };
    case "DELIVERED":
      return { deliveredAt: now };
    case "CANCELLED":
      return { cancelledAt: now };
    case "RETURN_REQUESTED":
      return { returnRequestedAt: now };
    case "RETURNED":
      return { returnedAt: now };
    case "REFUNDED":
      return { refundedAt: now };
    default:
      return {};
  }
}

export interface TransitionOrderStatusOptions {
  /** Extra financial fields that become known exactly at this transition, e.g.
   *  returnAmountUsdCents when moving to RETURNED, or shippingCostJpy when moving to SHIPPED. */
  extra?: Partial<
    Pick<
      typeof orders.$inferInsert,
      "returnAmountUsdCents" | "ebayFeeUsdCents" | "paymentFeeUsdCents" | "shippingCostJpy" | "adSpendUsdCents" | "fxCostUsdCents"
    >
  >;
}

/**
 * Every status change is human-triggered via the admin API (see admin-api's order routes) --
 * never automatic -- and always validated against @ai-ec/core's isValidOrderTransition first,
 * so a client can't force an illegal jump (e.g. straight to SHIPPED) or resurrect a terminal
 * order by calling this directly.
 */
export async function transitionOrderStatus(
  db: Database,
  orderId: string,
  toStatus: OrderStatus,
  options: TransitionOrderStatusOptions = {},
): Promise<OrderRow> {
  const [current] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!current) throw new Error(`orders row missing for id ${orderId}`);

  const fromStatus = current.status as OrderStatus;
  if (!isValidOrderTransition(fromStatus, toStatus)) {
    throw new InvalidOrderTransitionError(fromStatus, toStatus);
  }

  const now = new Date();
  const [updated] = await db
    .update(orders)
    .set({ status: toStatus, ...statusTimestampPatch(toStatus, now), ...options.extra, updatedAt: now })
    .where(eq(orders.id, orderId))
    .returning();
  if (!updated) throw new Error(`failed to update orders row ${orderId}`);
  return updated;
}

function buildProfitInputs(order: OrderRow, usdPerJpy: number): OrderProfitInputs {
  return {
    costJpy: order.costJpy,
    salePriceJpy: order.salePriceJpy,
    salePriceUsdCents: order.salePriceUsdCents,
    ebayFeeUsdCents: order.ebayFeeUsdCents,
    paymentFeeUsdCents: order.paymentFeeUsdCents,
    shippingCostJpy: order.shippingCostJpy,
    adSpendUsdCents: order.adSpendUsdCents,
    fxCostUsdCents: order.fxCostUsdCents,
    returnAmountUsdCents: order.returnAmountUsdCents,
    usdPerJpy,
  };
}

/** Live (not-yet-finalized) profit, computed on demand -- never stored unless finalized. */
export function getLiveOrderProfit(order: OrderRow, usdPerJpy: number): OrderProfitResult {
  return computeOrderProfit(buildProfitInputs(order, usdPerJpy));
}

/**
 * 利益確定 lifecycle stage (item #4). Safe to call more than once -- e.g. an admin corrects a
 * fee and re-finalizes -- because it only ever overwrites this order's own snapshot with a
 * fresh computation from this order's own current fields; it never adds to a running total,
 * which is exactly what keeps a later return/reprocessing from double-counting profit.
 */
export async function finalizeOrderProfit(db: Database, orderId: string, usdPerJpy: number): Promise<OrderRow> {
  const [current] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!current) throw new Error(`orders row missing for id ${orderId}`);

  const profit = getLiveOrderProfit(current, usdPerJpy);
  const [updated] = await db
    .update(orders)
    .set({ finalizedNetProfitUsdCents: profit.netProfitUsdCents, profitFinalizedAt: new Date(), updatedAt: new Date() })
    .where(eq(orders.id, orderId))
    .returning();
  if (!updated) throw new Error(`failed to finalize profit for orders row ${orderId}`);
  return updated;
}

export async function listOrdersForProduct(db: Database, productId: string): Promise<OrderRow[]> {
  return db.select().from(orders).where(eq(orders.productId, productId)).orderBy(desc(orders.placedAt));
}

/** Units tied up in orders placed but not yet shipped -- see getInventoryBreakdown's
 *  "reserved" figure, which calls this same list for its sum. */
export const RESERVED_ORDER_STATUSES: OrderStatus[] = ["ORDER_RECEIVED", "PAID", "ALLOCATED"];

export async function listOrders(db: Database, options: { status?: OrderStatus; limit?: number } = {}): Promise<OrderRow[]> {
  const limit = options.limit ?? 100;
  if (options.status) {
    return db.select().from(orders).where(eq(orders.status, options.status)).orderBy(desc(orders.placedAt)).limit(limit);
  }
  return db.select().from(orders).orderBy(desc(orders.placedAt)).limit(limit);
}

export async function listReservedOrdersForProduct(db: Database, productId: string): Promise<OrderRow[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.productId, productId), inArray(orders.status, RESERVED_ORDER_STATUSES)));
}
