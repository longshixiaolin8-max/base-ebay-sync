import { BaseAdapter } from "@ai-ec/adapter-base";
import { contentHash, type ExternalProduct, getPlanLimits } from "@ai-ec/core";
import {
  applyBaseStockReport,
  channelListings,
  countProducts,
  getTenantBillingStatus,
  inventoryMaster,
  isChannelIsolated,
  listActiveTenants,
  productMaster,
  syncJobs,
  type Database,
} from "@ai-ec/db";
import {
  emitChannelIsolatedMetric,
  enqueue,
  getAppCredentials,
  getDb,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  recordSyncError,
} from "@ai-ec/lambda-shared";
import { and, eq, inArray, sql } from "drizzle-orm";

interface BaseAppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Structural subset of Database a Drizzle transaction's `tx` handle also satisfies --
 *  mirrors InventoryWriteDb in packages/db/src/inventory.ts's own Phase-4 outbox helper. */
type OutboxTxDb = { insert: Database["insert"]; select: Database["select"] };

type OutboxJobType = "ai_generate" | "ebay_update";
const OUTBOX_JOB_TYPES: OutboxJobType[] = ["ai_generate", "ebay_update"];

type SyncJobRow = typeof syncJobs.$inferSelect;

/**
 * Transactional Outbox insert: writes the pending-dispatch row in the SAME transaction as
 * the product_master change it describes, so the two can never commit independently. This
 * is the actual fix for the dual-write bug this file used to have -- a DB commit succeeding
 * while the SQS enqueue that was supposed to follow it silently failed (or the whole
 * process crashed between the two) used to mean AI generation / eBay re-sync never happened
 * for that change, with no record anywhere that anything was missed. Now the enqueue is a
 * separate step (dispatchPendingOutboxJobs below) that only ever runs after this commits,
 * and its own failure updates just this row's status -- it can never take the product
 * change down with it, and it can always be retried on the next poll.
 *
 * idempotencyKey doubles as this row's own dedup guard, via sync_jobs' existing unique
 * (tenantId, idempotencyKey) index -- two overlapping invocations (or a retried
 * transaction) that land on the same key can never create two jobs for the same real-world
 * change.
 */
async function insertOutboxJob(
  tx: OutboxTxDb,
  tenantId: string,
  type: OutboxJobType,
  idempotencyKey: string,
  productId: string,
  payload: Record<string, unknown>,
): Promise<SyncJobRow> {
  const [inserted] = await tx
    .insert(syncJobs)
    .values({ tenantId, type, idempotencyKey, productId, payload, status: "pending" })
    .onConflictDoNothing({ target: [syncJobs.tenantId, syncJobs.idempotencyKey] })
    .returning();

  if (inserted) return inserted as SyncJobRow;

  const [existing] = await tx
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.tenantId, tenantId), eq(syncJobs.idempotencyKey, idempotencyKey)))
    .limit(1);
  // Can only be missing if we lost a race with a concurrent DELETE of the row we just
  // conflicted with -- this table is never deleted from, so this is unreachable in practice.
  return existing as SyncJobRow;
}

function queueUrlForJobType(queues: ReturnType<typeof getQueueUrls>, type: string): string | null {
  if (type === "ai_generate") return queues.aiGenerate;
  if (type === "ebay_update") return queues.ebaySync;
  return null;
}

/**
 * The dispatcher half of the Transactional Outbox: reads every pending (or
 * previously-failed) product-fetch outbox job for a tenant and attempts to actually send it
 * to SQS. Deliberately its own pass, decoupled from insertOutboxJob/upsertProduct -- an
 * enqueue failure here never touches the product_master row that already committed; it only
 * ever updates this job's own status, leaving it "failed" (never silently dropped) so the
 * *next* poll cycle's call to this same function picks it back up and retries. Runs across
 * every not-yet-completed job for the tenant, not just ones created this cycle, so a job
 * that failed to dispatch on a previous run is retried here too.
 */
export async function dispatchPendingOutboxJobs(
  db: Database,
  queues: ReturnType<typeof getQueueUrls>,
  tenantId: string,
): Promise<void> {
  const jobs = await db
    .select()
    .from(syncJobs)
    .where(and(eq(syncJobs.tenantId, tenantId), inArray(syncJobs.type, OUTBOX_JOB_TYPES), inArray(syncJobs.status, ["pending", "failed"])));

  for (const job of jobs) {
    const queueUrl = queueUrlForJobType(queues, job.type);
    if (!queueUrl) continue;

    try {
      await enqueue(queueUrl, job.payload, job.idempotencyKey);
      await db.update(syncJobs).set({ status: "completed", updatedAt: new Date() }).where(eq(syncJobs.id, job.id));
    } catch (err) {
      await db
        .update(syncJobs)
        .set({ status: "failed", attempts: job.attempts + 1, updatedAt: new Date() })
        .where(eq(syncJobs.id, job.id));
      await recordSyncError(db, {
        tenantId,
        jobId: job.id,
        channel: job.type === "ebay_update" ? "ebay" : "base",
        productId: job.productId,
        errorCode: "product_fetch_dispatch_failed",
        errorMessage: (err as Error).message,
        payload: { jobType: job.type, attempts: job.attempts + 1 },
      });
    }
  }
}

/**
 * Scheduled (EventBridge) poller: pulls BASE's product catalog into the Product Master.
 * BASE is always the origin for product data — this lambda only ever creates/updates
 * product_master rows sourced from BASE, never the reverse.
 */
export async function handler(): Promise<void> {
  const db = getDb();
  const queues = getQueueUrls();
  const tenants = await listActiveTenants(db);

  for (const tenant of tenants) {
    await pollTenant(db, queues, tenant.id);
  }
}

async function pollTenant(db: Database, queues: ReturnType<typeof getQueueUrls>, tenantId: string): Promise<void> {
  // Item A of the third hardening round ("チャネル障害時の隔離モード"), superseding item #4
  // of the second round ("チャネル別レート制御") -- isChannelIsolated() composes that same
  // 429/5xx signal and also reacts to a real authentication failure (an expired token with
  // no refresh token, or no OAuth connection at all), which never resolves itself by
  // retrying. CDK owns this Lambda's EventBridge schedule, so rewriting the cron expression
  // at runtime would just get reset on the next deploy; skipping this cycle's poll is the
  // effective-frequency-reduction that's actually safe to do from inside the function itself.
  const isolation = await isChannelIsolated(db, tenantId, "base");
  if (isolation.isolated) {
    emitChannelIsolatedMetric("base");
    await recordAuditLog(db, {
      tenantId,
      actor: "system:product-fetch",
      action: "channel_isolated_skip",
      entityType: "channel",
      entityId: "base",
      after: { reasons: isolation.reasons },
    });
    return;
  }

  try {
    const creds = await getAppCredentials<BaseAppCredentials>("base");
    const adapter = new BaseAdapter(creds);

    const accountIds = await listConnectedAccountIds(db, tenantId, "base");
    for (const accountId of accountIds) {
      const accessToken = await getValidAccessToken(db, tenantId, adapter, accountId);

      let cursor: string | undefined;
      do {
        const { items, nextCursor } = await adapter.listProducts(accessToken, { cursor });
        for (const item of items) {
          // BASE's list endpoint (items/search) only ever returns up to 5 image slots
          // (img1_origin..img5_origin) by design -- confirmed against BASE's own API
          // reference -- while items/detail supports the full 20. A real product with 6+
          // photos would silently lose the rest if we trusted the list response's images,
          // so re-fetch the authoritative per-item detail before upserting.
          const detail = await adapter.getProduct(accessToken, item.externalId);
          await upsertProduct(db, tenantId, detail ?? item);
        }
        cursor = nextCursor;
      } while (cursor);
    }

    // Separate dispatcher pass -- see dispatchPendingOutboxJobs' own comment. Runs after
    // every account's full catalog page has been upserted, and covers this tenant's whole
    // backlog of not-yet-completed jobs, not just ones this cycle just created, so a job
    // that failed to dispatch on an earlier poll gets retried here too.
    await dispatchPendingOutboxJobs(db, queues, tenantId);
  } catch (err) {
    // Previously an unhandled failure here (e.g. a broken BASE token) would just abort the
    // whole invocation with no channel-tagged record of why -- invisible to
    // isChannelIsolated/computeSyncConfidence, which only ever read sync_errors.
    await recordSyncError(db, {
      tenantId,
      channel: "base",
      productId: null,
      errorCode: "product_fetch_failed",
      errorMessage: (err as Error).message,
    });
  }
}

export async function upsertProduct(db: Database, tenantId: string, item: ExternalProduct): Promise<void> {
  const sku = `base-${item.externalId}`;
  const hash = contentHash({
    title: item.title,
    descriptionHtml: item.descriptionHtml,
    priceJpy: item.priceJpy,
    images: item.images,
  });

  const [existing] = await db
    .select()
    .from(productMaster)
    .where(and(eq(productMaster.tenantId, tenantId), eq(productMaster.sku, sku)))
    .limit(1);

  if (existing) {
    // contentHash covers title/description/price/images only, not stock -- a poll where
    // *only* BASE's stock number changed (a restock, or a manual adjustment BASE never
    // reports as an "order") would otherwise never reach inventory_master at all. Always
    // reconcile the reported stock; applyBaseStockReport itself is the no-op guard when
    // nothing has actually changed on BASE (its out-of-order check on item.updatedAt).
    await applyBaseStockReport(db, tenantId, existing.id, item.quantity, item.updatedAt);
  }

  if (existing && existing.contentHash === hash) {
    return; // no other field changed since last import
  }

  if (existing) {
    // The product-row update and the eBay-update outbox row it may need to enqueue commit
    // in the same transaction -- see insertOutboxJob's own comment on why that atomicity is
    // the actual fix here: a DB update succeeding while the follow-up enqueue silently fails
    // used to mean this edit never reached eBay, with no trace that anything was missed.
    await db.transaction(async (tx) => {
      await tx
        .update(productMaster)
        .set({
          title: item.title,
          descriptionJa: item.descriptionHtml,
          priceJpy: item.priceJpy,
          images: item.images,
          contentHash: hash,
          updatedAt: new Date(),
        })
        .where(eq(productMaster.id, existing.id));

      const [ebayListing] = await tx
        .select()
        .from(channelListings)
        .where(and(eq(channelListings.productId, existing.id), eq(channelListings.channel, "ebay")))
        .limit(1);

      // Only push edits automatically for a listing a human already approved & published.
      // A listing still pending approval is left alone — the pending draft/approval flow owns it.
      if (ebayListing?.status === "published") {
        await insertOutboxJob(tx, tenantId, "ebay_update", `${tenantId}:ebay-update:${existing.id}:${hash}`, existing.id, {
          type: "ebay_update",
          tenantId,
          productId: existing.id,
        });
      }
    });
    return;
  }

  // Phase 3 of the SaaS conversion ("plan quota enforcement"). Only gates *new*
  // product creation -- a tenant already over quota keeps full visibility into (and
  // sync of) every product it already has via the `existing` branch above.
  //
  // The quota check and the insert used to be two separate round-trips
  // (countProducts() then a plain insert), which is a real TOCTOU race: two
  // overlapping invocations for the same tenant (e.g. a slow poll still running when
  // the next scheduled tick fires) could both read the same pre-insert count, both
  // pass the "under limit" check, and both insert -- breaching the quota. Wrapping the
  // count-check and the insert in one transaction, serialized per-tenant by a
  // transaction-scoped advisory lock, makes the second invocation always see the
  // first's committed insert before it re-reads the count.
  const billing = await getTenantBillingStatus(db, tenantId);
  const limit = getPlanLimits(billing?.plan ?? "standard").maxProducts;

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${tenantId} || ':product_quota')::bigint)`);

    const currentCount = await countProducts(tx, tenantId);
    if (currentCount >= limit) {
      return { ok: false as const, currentCount };
    }

    const [inserted] = await tx
      .insert(productMaster)
      .values({
        tenantId,
        sku,
        sourceChannel: "base",
        title: item.title,
        descriptionJa: item.descriptionHtml,
        priceJpy: item.priceJpy,
        images: item.images,
        status: "draft",
        contentHash: hash,
      })
      .returning();
    const newProductId = inserted!.id;

    await tx.insert(inventoryMaster).values({
      tenantId,
      productId: newProductId,
      quantity: item.quantity,
      version: 0,
      soldOut: item.quantity === 0,
      // Baseline the logical clock watermark to this first-seen BASE state, so the next
      // poll's applyBaseStockReport has something to compare against.
      lastBaseSeq: item.updatedAt,
    });
    await tx.insert(channelListings).values({
      tenantId,
      productId: newProductId,
      channel: "base",
      externalId: item.externalId,
      status: "published",
      lastSyncedAt: new Date(),
    });

    await insertOutboxJob(tx, tenantId, "ai_generate", `${tenantId}:ai-generate:${newProductId}`, newProductId, {
      type: "ai_generate",
      tenantId,
      productId: newProductId,
    });

    return { ok: true as const, productId: newProductId };
  });

  if (!result.ok) {
    await recordSyncError(db, {
      tenantId,
      channel: "base",
      productId: null,
      errorCode: "product_quota_exceeded",
      errorMessage: `Tenant has reached its plan's product limit (${limit})`,
      payload: { sku, currentCount: result.currentCount, limit },
    });
    return;
  }
  const productId = result.productId;

  // BASE登録 lifecycle stage (commercial-features round, item #4). This is the first
  // moment this platform ever knows about the product -- 仕入 (cost/purchase date) is a
  // separate, human-entered stage (see admin-api's purchase-info endpoint), since BASE's
  // own API has no concept of acquisition cost.
  await recordAuditLog(db, {
    tenantId,
    actor: "system:product-fetch",
    action: "product_listed_base",
    entityType: "product",
    entityId: productId,
    after: { sku, title: item.title },
  });
}
