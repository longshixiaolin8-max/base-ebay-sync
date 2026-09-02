import type { EbayInventoryLocationAddress } from "@ai-ec/adapter-ebay";
import { auditLog, channelListings, inventoryMaster, productMaster, syncErrors, syncJobs } from "@ai-ec/db";
import {
  createEbayAdapter,
  enqueue,
  getAppCredentials,
  getDb,
  getQueueUrls,
  getValidAccessToken,
  listConnectedAccountIds,
  recordAuditLog,
  type EbayAppCredentials,
} from "@ai-ec/lambda-shared";
import { desc, eq } from "drizzle-orm";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** Identity of the signed-in admin operator, as attached by the Cognito JWT authorizer. */
function actorFromEvent(event: APIGatewayProxyEventV2): string {
  const claims = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, string> } } })
    .authorizer?.jwt?.claims;
  return claims?.email ?? claims?.sub ?? "unknown-admin";
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const db = getDb();
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    if (method === "GET" && path === "/admin/products") {
      const products = await db.select().from(productMaster).orderBy(desc(productMaster.updatedAt)).limit(200);
      return json(200, { products });
    }

    if (method === "GET" && /^\/admin\/products\/[^/]+$/.test(path)) {
      const id = path.split("/")[3]!;
      const [product] = await db.select().from(productMaster).where(eq(productMaster.id, id)).limit(1);
      if (!product) return json(404, { error: "not_found" });
      const listings = await db.select().from(channelListings).where(eq(channelListings.productId, id));
      const [inventory] = await db.select().from(inventoryMaster).where(eq(inventoryMaster.productId, id)).limit(1);
      return json(200, { product, listings, inventory });
    }

    if (method === "POST" && /^\/admin\/products\/[^/]+\/approve-ebay-listing$/.test(path)) {
      const id = path.split("/")[3]!;
      const [ebayListing] = await db
        .select()
        .from(channelListings)
        .where(eq(channelListings.productId, id))
        .limit(1);
      if (!ebayListing) return json(404, { error: "no_ebay_draft_for_product" });
      if (ebayListing.status === "published") return json(409, { error: "already_published" });

      const queues = getQueueUrls();
      await enqueue(queues.ebaySync, { type: "ebay_publish", productId: id }, `ebay-publish:${id}`);

      await recordAuditLog(db, {
        actor: actorFromEvent(event),
        action: "ebay_listing_publish_approved",
        entityType: "product",
        entityId: id,
      });

      return json(202, { status: "publish_queued" });
    }

    if (method === "GET" && path === "/admin/sync-errors") {
      const resolvedOnly = event.queryStringParameters?.resolved === "true";
      const rows = await db
        .select()
        .from(syncErrors)
        .where(eq(syncErrors.resolved, resolvedOnly))
        .orderBy(desc(syncErrors.createdAt))
        .limit(200);
      return json(200, { syncErrors: rows });
    }

    if (method === "POST" && /^\/admin\/sync-errors\/[^/]+\/retry$/.test(path)) {
      const id = path.split("/")[3]!;
      const [error] = await db.select().from(syncErrors).where(eq(syncErrors.id, id)).limit(1);
      if (!error) return json(404, { error: "not_found" });
      if (!error.jobId) return json(400, { error: "error_has_no_retryable_job" });

      const [job] = await db.select().from(syncJobs).where(eq(syncJobs.id, error.jobId)).limit(1);
      if (!job) return json(404, { error: "original_job_not_found" });

      const queues = getQueueUrls();
      const queueUrl =
        job.type === "ai_generate" ? queues.aiGenerate : job.type.startsWith("ebay_") ? queues.ebaySync : queues.inventorySync;
      await enqueue(queueUrl, { type: job.type, productId: job.productId, ...job.payload }, `retry:${id}:${Date.now()}`);
      await db.update(syncErrors).set({ resolved: true }).where(eq(syncErrors.id, id));

      await recordAuditLog(db, {
        actor: actorFromEvent(event),
        action: "sync_error_retried",
        entityType: "sync_error",
        entityId: id,
      });

      return json(202, { status: "retry_queued" });
    }

    if (method === "POST" && path === "/admin/ebay/location") {
      const body = JSON.parse(event.body ?? "{}") as {
        merchantLocationKey?: string;
        address?: EbayInventoryLocationAddress;
      };
      if (!body.merchantLocationKey || !body.address) {
        return json(400, { error: "merchantLocationKey_and_address_required" });
      }

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const [accountId] = await listConnectedAccountIds(db, "ebay");
      if (!accountId) return json(409, { error: "no_ebay_account_connected" });

      const accessToken = await getValidAccessToken(db, adapter, accountId);
      await adapter.createInventoryLocation(accessToken, body.merchantLocationKey, body.address);

      await recordAuditLog(db, {
        actor: actorFromEvent(event),
        action: "ebay_inventory_location_created",
        entityType: "ebay_location",
        entityId: body.merchantLocationKey,
      });

      return json(201, { merchantLocationKey: body.merchantLocationKey });
    }

    if (method === "GET" && path === "/admin/ebay/category-suggestions") {
      const q = event.queryStringParameters?.q;
      if (!q) return json(400, { error: "q_required" });

      const creds = await getAppCredentials<EbayAppCredentials>("ebay");
      const adapter = createEbayAdapter(creds);
      const appAccessToken = await adapter.getApplicationAccessToken();
      const suggestions = await adapter.suggestCategories(appAccessToken, q);

      return json(200, { suggestions });
    }

    if (method === "GET" && path === "/admin/audit-log") {
      const rows = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
      return json(200, { auditLog: rows });
    }

    return json(404, { error: "route_not_found" });
  } catch (err) {
    return json(500, { error: "internal_error", message: (err as Error).message });
  }
}
