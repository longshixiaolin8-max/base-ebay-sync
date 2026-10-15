import {
  assessDdpRequirement,
  computeOrderProfit,
  isValidOrderTransition,
  type OrderProfitInputs,
  type OrderProfitResult,
  type OrderStatus,
} from "@ai-ec/core";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { orders } from "./schema.js";

export type OrderRow = typeof orders.$inferSelect;

export class InvalidOrderTransitionError extends Error {
  constructor(from: OrderStatus, to: OrderStatus) {
    super(`Cannot transition order from ${from} to ${to}`);
    this.name = "InvalidOrderTransitionError";
  }
}

/** Thrown by transitionOrderStatus when moving a DDP-required order (see assessDdpRequirement,
 *  @ai-ec/core) to SHIPPED without options.ddpConfirmed -- the admin-api route maps this to a
 *  400 carrying reasonJa, rather than letting the transition (and an un-DDP'd shipment) through
 *  silently. */
export class DdpConfirmationRequiredError extends Error {
  constructor(readonly reasonJa: string) {
    super("DDP compliance confirmation is required before marking this order SHIPPED");
    this.name = "DdpConfirmationRequiredError";
  }
}

/** Thrown by transitionOrderStatus when the order's status changed between this call's read
 *  and its write (e.g. two admins acting on the same order at once) -- the update's WHERE
 *  clause only matches the row still sitting at the status this call validated against, so a
 *  concurrent transition makes it match zero rows instead of silently clobbering whatever the
 *  other call just wrote. The admin-api route maps this to a 409 so the caller can refetch and
 *  retry, rather than the second write winning by coincidence of commit order. */
export class OrderStatusConflictError extends Error {
  constructor(orderId: string, expectedStatus: OrderStatus) {
    super(`Order ${orderId} was no longer in status ${expectedStatus} -- it changed concurrently`);
    this.name = "OrderStatusConflictError";
  }
}

/** The subset of TransitionOrderStatusOptions.extra that feeds computeOrderProfit -- shared so
 *  admin-api's request-body whitelist and this module's own finalized-profit invalidation (see
 *  transitionOrderStatus) can never drift apart into two different ideas of "profit-affecting". */
export const PROFIT_AFFECTING_EXTRA_KEYS = [
  "returnAmountUsdCents",
  "ebayFeeUsdCents",
  "paymentFeeUsdCents",
  "shippingCostJpy",
  "adSpendUsdCents",
  "fxCostUsdCents",
] as const;

export interface UpsertOrderReceivedInput {
  tenantId: string;
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
  /** eBay's own line-item id, needed later to call createShippingFulfillment -- see
   *  @ai-ec/core's SaleEvent.externalLineItemId. Undefined/null for a BASE sale. */
  ebayLineItemId?: string | null;
  /** See @ai-ec/core's SaleEvent.buyerEmail/buyerName -- only ever set for a BASE sale. */
  buyerEmail?: string | null;
  buyerName?: string | null;
  /** See @ai-ec/core's SaleEvent.shipToCountryCode -- best-effort, only ever attempted for an
   *  eBay sale, and may still be null/undefined even then. */
  shipToCountryCode?: string | null;
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
      tenantId: input.tenantId,
      productId: input.productId,
      channel: input.channel,
      externalOrderId: input.externalOrderId,
      quantity: input.quantity,
      status: "ORDER_RECEIVED",
      placedAt: input.placedAt,
      costJpy: input.costJpy ?? null,
      salePriceJpy: input.salePriceJpy ?? null,
      salePriceUsdCents: input.salePriceUsdCents ?? null,
      ebayLineItemId: input.ebayLineItemId ?? null,
      buyerEmail: input.buyerEmail ?? null,
      buyerName: input.buyerName ?? null,
      shipToCountryCode: input.shipToCountryCode ?? null,
    })
    .onConflictDoNothing({ target: [orders.channel, orders.externalOrderId, orders.productId] });

  const [row] = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, input.tenantId),
        eq(orders.channel, input.channel),
        eq(orders.externalOrderId, input.externalOrderId),
        eq(orders.productId, input.productId),
      ),
    )
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
      | "returnAmountUsdCents"
      | "ebayFeeUsdCents"
      | "paymentFeeUsdCents"
      | "shippingCostJpy"
      | "adSpendUsdCents"
      | "fxCostUsdCents"
      | "trackingNumber"
      | "shippingCarrierCode"
    >
  >;
  /** A human's affirmative confirmation (checkbox) that a DDP-required order was shipped via a
   *  DDP shipping method -- see assessDdpRequirement/DdpConfirmationRequiredError. Ignored for
   *  any transition other than SHIPPED, and for an order that doesn't require it. */
  ddpConfirmed?: boolean;
}

/**
 * Every status change is human-triggered via the admin API (see admin-api's order routes) --
 * never automatic -- and always validated against @ai-ec/core's isValidOrderTransition first,
 * so a client can't force an illegal jump (e.g. straight to SHIPPED) or resurrect a terminal
 * order by calling this directly.
 */
export async function transitionOrderStatus(
  db: Database,
  tenantId: string,
  orderId: string,
  toStatus: OrderStatus,
  options: TransitionOrderStatusOptions = {},
): Promise<OrderRow> {
  const [current] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  if (!current) throw new Error(`orders row missing for id ${orderId}`);

  const fromStatus = current.status as OrderStatus;
  if (!isValidOrderTransition(fromStatus, toStatus)) {
    throw new InvalidOrderTransitionError(fromStatus, toStatus);
  }

  // See assessDdpRequirement (@ai-ec/core) and DdpConfirmationRequiredError's own doc comment.
  // Gated here (using the `current` row already fetched above) rather than as a separate query
  // in the admin-api route, so the check and the write happen against the same row and in one
  // round trip.
  let justConfirmedDdp = false;
  if (toStatus === "SHIPPED" && !current.ddpConfirmedAt) {
    const ddp = assessDdpRequirement({
      channel: current.channel,
      shipToCountryCode: current.shipToCountryCode,
      salePriceUsdCents: current.salePriceUsdCents,
      placedAt: current.placedAt,
    });
    if (ddp.status === "required") {
      if (!options.ddpConfirmed) throw new DdpConfirmationRequiredError(ddp.reasonJa);
      justConfirmedDdp = true;
    }
  }

  // A financial field changing on an order whose profit snapshot was already finalized (e.g. a
  // return amount arriving at RETURNED, or an admin correcting a fee after the fact) makes that
  // snapshot wrong the instant this writes -- every reader that trusts profitFinalizedAt as
  // ground truth (dashboard/analytics/ops KPIs) would otherwise keep serving the pre-return
  // number forever, since nothing else ever re-finalizes on its own. Clearing it here falls
  // back those readers to the live (correct) computation until a human re-finalizes, which
  // matches finalizeOrderProfit's own doc comment ("an admin corrects a fee ... then
  // re-finalizes") -- this is the invalidation that comment assumed already existed.
  const extraTouchesProfitFields =
    !!options.extra && PROFIT_AFFECTING_EXTRA_KEYS.some((key) => key in (options.extra as Record<string, unknown>));
  const invalidatesFinalizedProfit = Boolean(current.profitFinalizedAt) && extraTouchesProfitFields;

  const now = new Date();
  const [updated] = await db
    .update(orders)
    .set({
      ...statusTimestampPatch(toStatus, now),
      ...options.extra,
      // status is applied last and unconditionally -- options.extra is caller-supplied and
      // only loosely typed at the call site (see admin-api's own extra-key whitelist), so this
      // guarantees the state machine's validated toStatus always wins even if extra somehow
      // carried a stray "status" key, rather than letting a spread ordering accident silently
      // resurrect or corrupt an order's status.
      status: toStatus,
      ...(justConfirmedDdp ? { ddpConfirmedAt: now } : {}),
      ...(invalidatesFinalizedProfit ? { profitFinalizedAt: null, finalizedNetProfitUsdCents: null } : {}),
      updatedAt: now,
    })
    // Guarding on the status this call validated against (not just tenantId/id) is this
    // function's optimistic-concurrency check: if another call already moved the order off
    // fromStatus between our read above and this write, this matches zero rows instead of
    // blindly overwriting whatever that other call just committed.
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId), eq(orders.status, fromStatus)))
    .returning();
  if (!updated) throw new OrderStatusConflictError(orderId, fromStatus);
  return updated;
}

/** Set once createShippingFulfillment has actually succeeded against eBay -- called by the
 *  admin-api route only after that call returns without throwing, never speculatively. */
export async function markEbayTrackingSynced(db: Database, tenantId: string, orderId: string): Promise<void> {
  await db
    .update(orders)
    .set({ ebayTrackingSyncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)));
}

function buildProfitInputs(order: OrderRow, usdPerJpy: number): OrderProfitInputs {
  return {
    costJpy: order.costJpy,
    quantity: order.quantity,
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
export async function finalizeOrderProfit(db: Database, tenantId: string, orderId: string, usdPerJpy: number): Promise<OrderRow> {
  const [current] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .limit(1);
  if (!current) throw new Error(`orders row missing for id ${orderId}`);

  const profit = getLiveOrderProfit(current, usdPerJpy);
  const [updated] = await db
    .update(orders)
    .set({ finalizedNetProfitUsdCents: profit.netProfitUsdCents, profitFinalizedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
    .returning();
  if (!updated) throw new Error(`failed to finalize profit for orders row ${orderId}`);
  return updated;
}

export interface TenantMarginHistory {
  /** This tenant's own average realized cost-markup ratio (net profit / cost, same units as
   *  computeDynamicPrice's targetMarginRatio/costMarkupRatio -- NOT net profit / revenue,
   *  which is a different ratio computeDynamicPrice would silently underprice against if fed
   *  in here instead) across its most recent finalized eBay orders. Cost is reconstructed as
   *  revenue - netProfit (computeOrderProfit's own definition of netProfit), so this needs no
   *  separate cost column and stays correct however each order was actually priced. Null when
   *  there isn't a single usable order yet. */
  avgMarkupRatio: number | null;
  sampleSize: number;
}

/**
 * Feeds computeLearnedTargetMargin's personalized baseline (packages/core/src/margin-
 * learning.ts) -- a tenant's own track record in place of the platform's one-size-fits-all
 * DEFAULT_TARGET_MARGIN_RATIO. Scoped to eBay orders only: salePriceUsdCents is already
 * USD-denominated there, so no FX rate needs to stand in for whatever rate actually applied
 * back when each order was placed (a BASE/JPY order's margin would need that approximation,
 * which is fine for a live price *preview* but not for a figure this treats as ground truth).
 */
export async function getTenantMarginHistory(db: Database, tenantId: string, limit = 50): Promise<TenantMarginHistory> {
  const rows = await db
    .select({ netProfit: orders.finalizedNetProfitUsdCents, revenue: orders.salePriceUsdCents })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.channel, "ebay"),
        isNotNull(orders.profitFinalizedAt),
        isNotNull(orders.salePriceUsdCents),
      ),
    )
    .orderBy(desc(orders.profitFinalizedAt))
    .limit(limit);

  const ratios = rows
    .filter((r): r is { netProfit: number; revenue: number } => r.netProfit != null && r.revenue != null)
    .map((r) => ({ cost: r.revenue - r.netProfit, netProfit: r.netProfit }))
    .filter((r) => r.cost > 0)
    .map((r) => r.netProfit / r.cost);

  if (ratios.length === 0) return { avgMarkupRatio: null, sampleSize: 0 };
  const avgMarkupRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  return { avgMarkupRatio, sampleSize: ratios.length };
}

export async function listOrdersForProduct(db: Database, tenantId: string, productId: string): Promise<OrderRow[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.productId, productId)))
    .orderBy(desc(orders.placedAt));
}

/** Units tied up in orders placed but not yet shipped -- see getInventoryBreakdown's
 *  "reserved" figure, which calls this same list for its sum. */
export const RESERVED_ORDER_STATUSES: OrderStatus[] = ["ORDER_RECEIVED", "PAID", "ALLOCATED"];

export async function listOrders(
  db: Database,
  tenantId: string,
  options: { status?: OrderStatus; limit?: number } = {},
): Promise<OrderRow[]> {
  const limit = options.limit ?? 100;
  if (options.status) {
    return db
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.status, options.status)))
      .orderBy(desc(orders.placedAt))
      .limit(limit);
  }
  return db.select().from(orders).where(eq(orders.tenantId, tenantId)).orderBy(desc(orders.placedAt)).limit(limit);
}

export async function listReservedOrdersForProduct(db: Database, tenantId: string, productId: string): Promise<OrderRow[]> {
  return db
    .select()
    .from(orders)
    .where(and(eq(orders.tenantId, tenantId), eq(orders.productId, productId), inArray(orders.status, RESERVED_ORDER_STATUSES)));
}
