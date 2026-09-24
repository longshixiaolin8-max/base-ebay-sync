import type { Database } from "./client.js";
import { tenants } from "./schema.js";

/**
 * The one real business this platform served before multi-tenancy existed. Fixed rather
 * than looked up, so the migration that backfills every table's tenant_id column and every
 * environment built from scratch can reference the exact same row without a lookup.
 */
export const BOOTSTRAP_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** Every tenant a scheduled worker (product-fetch, sales-poller, inventory-diff-check)
 *  should loop over -- there is no "active" flag yet, every row here is in scope. */
export async function listActiveTenants(db: Database): Promise<Array<{ id: string }>> {
  return db.select({ id: tenants.id }).from(tenants);
}
