import { getDb } from "@ai-ec/lambda-shared";
import { BOOTSTRAP_TENANT_ID } from "@ai-ec/db";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/aws-data-api/pg/migrator";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Applies every pending packages/db/migrations/*.sql file (drizzle's own aws-data-api
 * migrator, which tracks what's already applied in its own __drizzle_migrations table.
 * Legacy migrations 0001-0018 are deliberately replay-safe because early environments had
 * some schema changes applied manually before this ledger was consistently maintained.
 * That lets a missing ledger row converge on the existing schema instead of failing on an
 * already-present column/constraint. After migration, this handler seeds
 * the platform's fixed bootstrap tenant row.
 *
 * No environment (dev or prod) has ever had a script or CI step that actually runs these
 * migrations -- every one of them was applied by hand from a session that happened to have
 * direct database access at the time (see README's old "一度きりの人手による" bootstrap
 * step). This Lambda is meant to be invoked manually (AWS Console "Test", or `aws lambda
 * invoke`) once per fresh environment, and again whenever new migrations are added.
 */
export async function handler(): Promise<{ bootstrapTenantId: string }> {
  const db = getDb();

  await migrate(db, { migrationsFolder: path.join(__dirname, "migrations") });

  // Never created by any migration -- packages/db/src/tenants.ts's BOOTSTRAP_TENANT_ID is
  // referenced throughout the codebase (e.g. ebay-webhook's fallback poll target) as if a
  // row for it already exists, but nothing before this ever inserted one. The explicit
  // ::uuid cast is load-bearing: the Data API sends the bound parameter as a plain string,
  // and "id" won't implicitly coerce text -> uuid (confirmed live: 42804 "column is of
  // type uuid but expression is of type text" without it).
  await db.execute(sql`
    INSERT INTO "tenants" ("id", "name", "plan", "status")
    VALUES (${BOOTSTRAP_TENANT_ID}::uuid, 'Bootstrap Tenant', 'standard', 'active')
    ON CONFLICT ("id") DO NOTHING
  `);

  return { bootstrapTenantId: BOOTSTRAP_TENANT_ID };
}
