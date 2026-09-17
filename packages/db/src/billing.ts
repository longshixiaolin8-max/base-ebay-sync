import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { tenants } from "./schema.js";

export type TenantStatus = "pending_payment" | "active" | "past_due" | "canceled_grace" | "canceled";

interface BillingStatusRow {
  plan: string;
  status: TenantStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  name: string;
  gracePeriodEndsAt: Date | null;
  lastBillingEventAt: Date | null;
}

/**
 * Phase 2 of the SaaS conversion ("self-service signup + Stripe test-mode billing").
 * A tenant created through the public /signup flow starts life unpaid -- it only becomes
 * usable once the Stripe webhook confirms a completed checkout (see markTenantActive).
 * Every other tenant-creation path in this codebase (the fixed bootstrap tenant) is
 * unaffected: the `status` column's own schema default is 'active', so this function's
 * explicit 'pending_payment' only ever applies to self-service-created tenants.
 */
export async function createPendingTenant(db: Database, name: string): Promise<{ id: string }> {
  const [row] = await db.insert(tenants).values({ name, status: "pending_payment" }).returning({ id: tenants.id });
  return row!;
}

export async function getTenantBillingStatus(db: Database, tenantId: string): Promise<BillingStatusRow | undefined> {
  const [row] = await db
    .select({
      plan: tenants.plan,
      status: tenants.status,
      stripeCustomerId: tenants.stripeCustomerId,
      stripeSubscriptionId: tenants.stripeSubscriptionId,
      name: tenants.name,
      gracePeriodEndsAt: tenants.gracePeriodEndsAt,
      lastBillingEventAt: tenants.lastBillingEventAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row as BillingStatusRow | undefined;
}

/**
 * Guards every status-changing billing update against out-of-order webhook delivery: an
 * incoming Stripe event whose own `created` timestamp is older than the last event this
 * tenant already applied is acknowledged (so Stripe stops retrying it) but never allowed to
 * overwrite newer state. Returns whether the update was actually applied.
 */
async function isStale(db: Database, tenantId: string, eventCreatedAt: Date): Promise<boolean> {
  const [row] = await db.select({ lastBillingEventAt: tenants.lastBillingEventAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return !!row?.lastBillingEventAt && row.lastBillingEventAt.getTime() > eventCreatedAt.getTime();
}

export async function markTenantActive(
  db: Database,
  tenantId: string,
  stripe: { stripeCustomerId: string; stripeSubscriptionId: string },
  eventCreatedAt: Date,
): Promise<boolean> {
  if (await isStale(db, tenantId, eventCreatedAt)) return false;
  await db
    .update(tenants)
    .set({
      status: "active",
      stripeCustomerId: stripe.stripeCustomerId,
      stripeSubscriptionId: stripe.stripeSubscriptionId,
      gracePeriodEndsAt: null,
      lastBillingEventAt: eventCreatedAt,
    })
    .where(eq(tenants.id, tenantId));
  return true;
}

export async function markTenantPastDue(db: Database, tenantId: string, eventCreatedAt: Date): Promise<boolean> {
  if (await isStale(db, tenantId, eventCreatedAt)) return false;
  await db.update(tenants).set({ status: "past_due", lastBillingEventAt: eventCreatedAt }).where(eq(tenants.id, tenantId));
  return true;
}

/**
 * The subscription's real end, not an immediate hard cutoff: the tenant keeps read-only
 * (GET-only) access to its own data -- including CSV export -- until `gracePeriodEndsAt`,
 * so canceling never locks a store out of its own data with zero notice. After that
 * instant, the admin-api billing gate treats it identically to a plain 'canceled' tenant.
 */
export async function markTenantCanceledWithGrace(
  db: Database,
  tenantId: string,
  eventCreatedAt: Date,
  gracePeriodDays = 30,
): Promise<{ applied: boolean; gracePeriodEndsAt: Date }> {
  const gracePeriodEndsAt = new Date(eventCreatedAt.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
  if (await isStale(db, tenantId, eventCreatedAt)) {
    return { applied: false, gracePeriodEndsAt };
  }
  await db
    .update(tenants)
    .set({ status: "canceled_grace", gracePeriodEndsAt, lastBillingEventAt: eventCreatedAt })
    .where(eq(tenants.id, tenantId));
  return { applied: true, gracePeriodEndsAt };
}

/**
 * The Stripe webhook only ever carries a Stripe customer/subscription id, never this
 * platform's own tenant id -- this is the reverse lookup that connects the two.
 */
export async function findTenantByStripeCustomerId(
  db: Database,
  stripeCustomerId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.stripeCustomerId, stripeCustomerId)).limit(1);
  return row;
}
