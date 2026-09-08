import { eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { tenants } from "./schema.js";

export type TenantStatus = "pending_payment" | "active" | "past_due" | "canceled";

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

export async function getTenantBillingStatus(
  db: Database,
  tenantId: string,
): Promise<
  | { plan: string; status: TenantStatus; stripeCustomerId: string | null; stripeSubscriptionId: string | null; name: string }
  | undefined
> {
  const [row] = await db
    .select({
      plan: tenants.plan,
      status: tenants.status,
      stripeCustomerId: tenants.stripeCustomerId,
      stripeSubscriptionId: tenants.stripeSubscriptionId,
      name: tenants.name,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return row as
    | { plan: string; status: TenantStatus; stripeCustomerId: string | null; stripeSubscriptionId: string | null; name: string }
    | undefined;
}

export async function markTenantActive(
  db: Database,
  tenantId: string,
  stripe: { stripeCustomerId: string; stripeSubscriptionId: string },
): Promise<void> {
  await db
    .update(tenants)
    .set({
      status: "active",
      stripeCustomerId: stripe.stripeCustomerId,
      stripeSubscriptionId: stripe.stripeSubscriptionId,
    })
    .where(eq(tenants.id, tenantId));
}

export async function markTenantInactive(
  db: Database,
  tenantId: string,
  status: Extract<TenantStatus, "past_due" | "canceled">,
): Promise<void> {
  await db.update(tenants).set({ status }).where(eq(tenants.id, tenantId));
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
