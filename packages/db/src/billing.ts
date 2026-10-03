import { and, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { tenants } from "./schema.js";

export type TenantStatus = "pending_payment" | "active" | "past_due" | "canceled_grace" | "canceled";

interface BillingWriteDb {
  select: Database["select"];
  update: Database["update"];
}

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
 * Creates the isolated tenant only after Cognito accepted the public SignUp request.
 * Passing the pre-generated id lets Cognito's custom:tenant_id claim and the DB row be
 * created as one compensatable saga rather than creating an unreferenced DB tenant first.
 */
export async function createPendingTenant(
  db: Database,
  name: string,
  options?: { id?: string; contactEmail?: string },
): Promise<{ id: string }> {
  const [row] = await db
    .insert(tenants)
    .values({
      ...(options?.id ? { id: options.id } : {}),
      name,
      status: "pending_payment",
      contactEmail: options?.contactEmail ?? null,
    })
    .returning({ id: tenants.id });
  return row!;
}

/** Compensation used only when public signup fails before any paid subscription exists. */
export async function deletePendingTenant(db: Database, tenantId: string): Promise<void> {
  await db.delete(tenants).where(and(eq(tenants.id, tenantId), eq(tenants.status, "pending_payment")));
}

/**
 * Persists the Stripe customer as soon as it is created, before Checkout. Retrying email
 * confirmation/checkout therefore reuses one Stripe customer instead of leaking duplicates.
 */
export async function setPendingTenantStripeCustomerId(db: Database, tenantId: string, stripeCustomerId: string): Promise<void> {
  await db
    .update(tenants)
    .set({ stripeCustomerId })
    .where(and(eq(tenants.id, tenantId), eq(tenants.status, "pending_payment")));
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

async function isStale(db: BillingWriteDb, tenantId: string, eventCreatedAt: Date): Promise<boolean> {
  const [row] = await db.select({ lastBillingEventAt: tenants.lastBillingEventAt }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  return !!row?.lastBillingEventAt && row.lastBillingEventAt.getTime() > eventCreatedAt.getTime();
}

export async function markTenantActive(
  db: BillingWriteDb,
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

export async function markTenantPastDue(db: BillingWriteDb, tenantId: string, eventCreatedAt: Date): Promise<boolean> {
  if (await isStale(db, tenantId, eventCreatedAt)) return false;
  await db.update(tenants).set({ status: "past_due", lastBillingEventAt: eventCreatedAt }).where(eq(tenants.id, tenantId));
  return true;
}

export async function markTenantCanceledWithGrace(
  db: BillingWriteDb,
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

export async function markTenantMarketplaceOffboarded(db: Database, tenantId: string, offboardedAt = new Date()): Promise<void> {
  await db.update(tenants).set({ marketplaceOffboardedAt: offboardedAt }).where(eq(tenants.id, tenantId));
}

export async function findTenantByStripeCustomerId(
  db: BillingWriteDb,
  stripeCustomerId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.stripeCustomerId, stripeCustomerId)).limit(1);
  return row;
}
