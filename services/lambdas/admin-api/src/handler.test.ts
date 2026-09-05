import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const computeSyncConfidenceMock = vi.fn().mockResolvedValue({
  channel: "ebay",
  score: 100,
  windowHours: 24,
  successCount: 0,
  failureCount: 0,
  outOfOrderEventCount: 0,
  totalEventCount: 0,
});

const computeDynamicSafetyStockMock = vi.fn().mockResolvedValue({
  productId: "product-1",
  channel: "ebay",
  recommendedBuffer: 0,
  salesPerDay: 0,
  windowDays: 7,
  pollIntervalMinutes: 1,
  confidenceScore: 100,
  riskMultiplier: 1,
});

const reconstructInventoryMock = vi.fn().mockResolvedValue({
  reconstructedQuantity: 3,
  currentQuantity: 3,
  drifted: false,
  eventsReplayed: 1,
});

const applyReconstructedInventoryMock = vi.fn().mockResolvedValue({
  reconstructedQuantity: 3,
  currentQuantity: 3,
  drifted: false,
  eventsReplayed: 1,
  applied: false,
});

const predictStockoutRiskMock = vi.fn().mockResolvedValue({
  productId: "product-1",
  daysUntilStockout: null,
  highRisk: false,
  salesPerDay: 0,
  currentQuantity: 5,
  windowDays: 7,
});

const traceSyncHistoryMock = vi.fn().mockResolvedValue({ productId: "product-1", entries: [] });

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  channelListings: { productId: "productId" },
  inventoryMaster: {},
  syncErrors: {},
  syncJobs: {},
  auditLog: {},
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
  computeDynamicSafetyStock: (...args: unknown[]) => computeDynamicSafetyStockMock(...args),
  reconstructInventory: (...args: unknown[]) => reconstructInventoryMock(...args),
  applyReconstructedInventory: (...args: unknown[]) => applyReconstructedInventoryMock(...args),
  predictStockoutRisk: (...args: unknown[]) => predictStockoutRiskMock(...args),
  traceSyncHistory: (...args: unknown[]) => traceSyncHistoryMock(...args),
}));

const enqueueMock = vi.fn().mockResolvedValue(undefined);
const recordAuditLogMock = vi.fn().mockResolvedValue(undefined);
const getQueueUrlsMock = vi.fn(() => ({
  aiGenerate: "ai-generate-url",
  ebaySync: "ebay-sync-url",
  inventorySync: "inventory-sync-url",
}));
let fakeDb: unknown;
const getDbMock = vi.fn(() => fakeDb);
const getAppCredentialsMock = vi.fn().mockResolvedValue({ clientId: "cid" });
const listConnectedAccountIdsMock = vi.fn().mockResolvedValue(["acct-1"]);
const getValidAccessTokenMock = vi.fn().mockResolvedValue("token");
const createInventoryLocationMock = vi.fn().mockResolvedValue(undefined);
const getApplicationAccessTokenMock = vi.fn().mockResolvedValue("app-token");
const suggestCategoriesMock = vi.fn().mockResolvedValue([{ ebayCategoryId: "10364", label: "Bracelets" }]);
const optInToBusinessPoliciesMock = vi.fn().mockResolvedValue(undefined);
const createFulfillmentPolicyMock = vi.fn().mockResolvedValue("fp-1");
const createPaymentPolicyMock = vi.fn().mockResolvedValue("pp-1");
const createReturnPolicyMock = vi.fn().mockResolvedValue("rp-1");
const createNotificationDestinationMock = vi.fn().mockResolvedValue({ destinationId: "dest-1" });
const createNotificationSubscriptionMock = vi.fn().mockResolvedValue({ subscriptionId: "sub-1" });
const updateNotificationConfigMock = vi.fn().mockResolvedValue(undefined);
const listProductsMock = vi.fn().mockResolvedValue({ items: [], nextCursor: undefined });
const getRequiredItemAspectsMock = vi.fn().mockResolvedValue([]);
const createEbayAdapterMock = vi.fn((..._args: unknown[]) => ({
  createInventoryLocation: createInventoryLocationMock,
  getApplicationAccessToken: getApplicationAccessTokenMock,
  suggestCategories: suggestCategoriesMock,
  optInToBusinessPolicies: optInToBusinessPoliciesMock,
  createFulfillmentPolicy: createFulfillmentPolicyMock,
  createPaymentPolicy: createPaymentPolicyMock,
  createReturnPolicy: createReturnPolicyMock,
  createNotificationDestination: createNotificationDestinationMock,
  createNotificationSubscription: createNotificationSubscriptionMock,
  updateNotificationConfig: updateNotificationConfigMock,
  listProducts: listProductsMock,
  getRequiredItemAspects: getRequiredItemAspectsMock,
}));

const fetchFxRateMock = vi.fn().mockResolvedValue({ fxRateUsdPerJpy: 0.0067, source: "test", fetchedAt: new Date() });
vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: () => getDbMock(),
  getQueueUrls: () => getQueueUrlsMock(),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
  getAppCredentials: (...args: unknown[]) => getAppCredentialsMock(...args),
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
  createEbayAdapter: (...args: unknown[]) => createEbayAdapterMock(...args),
  fetchFxRate: (...args: unknown[]) => fetchFxRateMock(...args),
}));

const { handler } = await import("./handler.js");

/** The handler always returns the {statusCode, body} shape; narrow away the union for tests. */
async function callHandler(event: APIGatewayProxyEventV2) {
  return (await handler(event)) as { statusCode: number; body?: string };
}

/** A drizzle-style query chain that resolves to `result` no matter which methods are chained. */
function chain(result: unknown) {
  const self: Record<string, unknown> = {
    from: () => self,
    where: () => self,
    orderBy: () => self,
    limit: () => self,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return self;
}

function createFakeDb(selectResults: unknown[]) {
  let i = 0;
  return {
    select: () => chain(selectResults[i++]),
    update: vi.fn(() => ({ set: () => ({ where: async () => undefined }) })),
    insert: vi.fn(() => ({ values: async () => undefined })),
  };
}

function makeEvent(
  method: string,
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    queryStringParameters: query,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "0.0.0.0", userAgent: "test" },
      authorizer: { jwt: { claims: { email: "admin@example.com" }, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2;
}

describe("admin-api handler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    recordAuditLogMock.mockClear();
  });

  it("GET /admin/products returns the product list", async () => {
    fakeDb = createFakeDb([[{ id: "p1" }, { id: "p2" }]]);
    const res = await callHandler(makeEvent("GET", "/admin/products"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ products: [{ id: "p1" }, { id: "p2" }] });
  });

  it("GET /admin/products/{id} returns 404 when the product doesn't exist", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("GET", "/admin/products/missing-id"));
    expect(res.statusCode).toBe(404);
  });

  it("GET /admin/products/{id} returns product + listings + inventory", async () => {
    fakeDb = createFakeDb([[{ id: "p1" }], [{ channel: "ebay" }], [{ quantity: 3 }]]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      product: { id: "p1" },
      listings: [{ channel: "ebay" }],
      inventory: { quantity: 3 },
    });
  });

  it("approve-ebay-listing returns 404 when there is no eBay draft yet", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/approve-ebay-listing"));
    expect(res.statusCode).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("approve-ebay-listing returns 409 when already published", async () => {
    fakeDb = createFakeDb([[{ status: "published" }]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/approve-ebay-listing"));
    expect(res.statusCode).toBe(409);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("approve-ebay-listing enqueues ebay_publish and records an audit log entry", async () => {
    fakeDb = createFakeDb([[{ status: "pending_approval" }]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/approve-ebay-listing"));
    expect(res.statusCode).toBe(202);
    expect(enqueueMock).toHaveBeenCalledWith(
      "ebay-sync-url",
      { type: "ebay_publish", productId: "p1" },
      "ebay-publish:p1",
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ actor: "admin@example.com", action: "ebay_listing_publish_approved" }),
    );
  });

  it("sync-errors retry returns 400 when the error has no retryable job", async () => {
    fakeDb = createFakeDb([[{ id: "e1", jobId: null }]]);
    const res = await callHandler(makeEvent("POST", "/admin/sync-errors/e1/retry"));
    expect(res.statusCode).toBe(400);
  });

  it("sync-errors retry re-enqueues the original job and marks the error resolved", async () => {
    fakeDb = createFakeDb([
      [{ id: "e1", jobId: "job-1" }],
      [{ id: "job-1", type: "ai_generate", productId: "p1", payload: {} }],
    ]);
    const res = await callHandler(makeEvent("POST", "/admin/sync-errors/e1/retry"));
    expect(res.statusCode).toBe(202);
    expect(enqueueMock).toHaveBeenCalledWith(
      "ai-generate-url",
      { type: "ai_generate", productId: "p1" },
      expect.stringContaining("retry:e1:"),
    );
  });

  it("POST /admin/ebay/location creates the location and records an audit log entry", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/location", {}, {
        merchantLocationKey: "osaka-main",
        address: {
          addressLine1: "Nagata 3-8-15-415",
          city: "Osaka-shi Joto-ku",
          stateOrProvince: "Osaka",
          postalCode: "536-0022",
          country: "JP",
        },
      }),
    );
    expect(res.statusCode).toBe(201);
    expect(createInventoryLocationMock).toHaveBeenCalledWith(
      "token",
      "osaka-main",
      expect.objectContaining({ postalCode: "536-0022" }),
    );
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "ebay_inventory_location_created", entityId: "osaka-main" }),
    );
  });

  it("POST /admin/ebay/location returns 400 when address is missing", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("POST", "/admin/ebay/location", {}, { merchantLocationKey: "x" }));
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/ebay/location returns 409 when no eBay account is connected", async () => {
    fakeDb = createFakeDb([]);
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/location", {}, {
        merchantLocationKey: "osaka-main",
        address: { addressLine1: "a", city: "b", stateOrProvince: "c", postalCode: "d", country: "JP" },
      }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/ebay/webhook-setup creates a destination and subscription", async () => {
    process.env.EBAY_WEBHOOK_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/notifications";
    getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid", webhookVerificationToken: "verify-me" });
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/webhook-setup", {}, { topicId: "LISTING", alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body!)).toEqual({ destinationId: "dest-1", subscriptionId: "sub-1" });
    expect(updateNotificationConfigMock).toHaveBeenCalledWith("token", "ops@example.com");
    expect(createNotificationDestinationMock).toHaveBeenCalledWith(
      "token",
      "AI EC Platform",
      "https://api.example.com/webhooks/ebay/notifications",
      "verify-me",
    );
    expect(createNotificationSubscriptionMock).toHaveBeenCalledWith("token", "LISTING", "dest-1");
  });

  it("POST /admin/ebay/webhook-setup returns 400 without a topicId or alertEmail", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("POST", "/admin/ebay/webhook-setup", {}, {}));
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/ebay/webhook-setup returns 409 when no verification token is configured", async () => {
    getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid" });
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/webhook-setup", {}, { topicId: "LISTING", alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/ebay/policies opts in and creates the three business policies", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("POST", "/admin/ebay/policies"));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body!)).toEqual({
      fulfillmentPolicyId: "fp-1",
      paymentPolicyId: "pp-1",
      returnPolicyId: "rp-1",
    });
    expect(optInToBusinessPoliciesMock).toHaveBeenCalledWith("token");
  });

  it("GET /admin/ebay/unmanaged-listings finds eBay SKUs with no channel_listings row, deterministically matching our own naming pattern only", async () => {
    listProductsMock.mockResolvedValueOnce({
      items: [
        { externalId: "base-tracked-1", title: "Already tracked" },
        { externalId: "base-999", title: "Matches a real product_master row" },
        { externalId: "hand-listed-sku", title: "Pre-existing, not ours" },
      ],
      nextCursor: undefined,
    });
    fakeDb = createFakeDb([
      [{ externalId: "base-tracked-1", productId: "tracked-product-id" }], // tracked channel_listings(ebay) rows
      [], // candidate product pool for fuzzy matching -- empty, so "hand-listed-sku" gets no suggestion
      [{ id: "product-999" }], // product_master lookup for base-999 -> deterministic match
    ]);

    const res = await callHandler(makeEvent("GET", "/admin/ebay/unmanaged-listings"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      unmanagedListings: [
        { externalId: "base-999", title: "Matches a real product_master row", suggestedProductId: "product-999" },
        { externalId: "hand-listed-sku", title: "Pre-existing, not ours", suggestedProductId: null },
      ],
    });
  });

  it("GET /admin/ebay/unmanaged-listings suggests a product by title/attribute similarity when there is no deterministic SKU match", async () => {
    // Item #5 of the third hardening round ("自動商品同一性判定").
    listProductsMock.mockResolvedValueOnce({
      items: [{ externalId: "hand-listed-sku", title: "Vintage Sterling Silver Bead Bracelet Cross Charm Taxco Style" }],
      nextCursor: undefined,
    });
    fakeDb = createFakeDb([
      [], // no tracked channel_listings(ebay) rows at all
      [
        {
          id: "candidate-1",
          title: "Vintage Sterling Silver Bead Bracelet Cross Charm Taxco",
          brand: null,
          material: null,
          sizeLabel: null,
        },
      ],
    ]);

    const res = await callHandler(makeEvent("GET", "/admin/ebay/unmanaged-listings"));

    expect(res.statusCode).toBe(200);
    const { unmanagedListings } = JSON.parse(res.body!) as {
      unmanagedListings: Array<{ suggestedProductId: string | null; matchScore?: number }>;
    };
    expect(unmanagedListings[0]!.suggestedProductId).toBe("candidate-1");
    expect(unmanagedListings[0]!.matchScore).toBeGreaterThanOrEqual(50);
  });

  it("POST /admin/products/{id}/link-ebay-listing links an unmanaged eBay SKU to a product", async () => {
    fakeDb = createFakeDb([[{ id: "product-1" }], [], []]); // product exists, no existing link, no conflict
    const res = await callHandler(
      makeEvent("POST", "/admin/products/product-1/link-ebay-listing", {}, { externalId: "hand-listed-sku" }),
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body!)).toEqual({ productId: "product-1", externalId: "hand-listed-sku" });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "ebay_listing_linked", entityId: "product-1" }),
    );
  });

  it("POST /admin/products/{id}/link-ebay-listing returns 404 for an unknown product", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/missing/link-ebay-listing", {}, { externalId: "sku-1" }),
    );
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/products/{id}/link-ebay-listing returns 409 when the product already has an eBay listing", async () => {
    fakeDb = createFakeDb([[{ id: "product-1" }], [{ externalId: "already-linked" }]]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/product-1/link-ebay-listing", {}, { externalId: "sku-1" }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/products/{id}/link-ebay-listing returns 409 when the eBay SKU is already linked elsewhere", async () => {
    fakeDb = createFakeDb([[{ id: "product-1" }], [], [{ productId: "other-product" }]]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/product-1/link-ebay-listing", {}, { externalId: "sku-1" }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("GET /admin/sync/confidence returns the computed score for a channel", async () => {
    computeSyncConfidenceMock.mockResolvedValueOnce({
      channel: "ebay",
      score: 63,
      windowHours: 24,
      successCount: 2,
      failureCount: 2,
      outOfOrderEventCount: 1,
      totalEventCount: 4,
    });
    const res = await callHandler(makeEvent("GET", "/admin/sync/confidence", { channel: "ebay" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ channel: "ebay", score: 63 });
    expect(computeSyncConfidenceMock).toHaveBeenCalledWith(fakeDb, "ebay", undefined);
  });

  it("GET /admin/sync/confidence returns 400 without a channel", async () => {
    const res = await callHandler(makeEvent("GET", "/admin/sync/confidence"));
    expect(res.statusCode).toBe(400);
  });

  it("GET /admin/products/{id}/dynamic-safety-stock returns the recommended buffer for a product", async () => {
    computeDynamicSafetyStockMock.mockResolvedValueOnce({
      productId: "product-1",
      channel: "ebay",
      recommendedBuffer: 2,
      salesPerDay: 3,
      windowDays: 7,
      pollIntervalMinutes: 1,
      confidenceScore: 90,
      riskMultiplier: 1,
    });
    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/dynamic-safety-stock"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ productId: "product-1", recommendedBuffer: 2 });
    expect(computeDynamicSafetyStockMock).toHaveBeenCalledWith(fakeDb, "product-1", "ebay");
  });

  it("GET /admin/products/{id}/stockout-risk returns the predicted stockout risk for a product", async () => {
    predictStockoutRiskMock.mockResolvedValueOnce({
      productId: "product-1",
      daysUntilStockout: 1.5,
      highRisk: true,
      salesPerDay: 2,
      currentQuantity: 3,
      windowDays: 7,
    });
    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/stockout-risk"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ productId: "product-1", highRisk: true, daysUntilStockout: 1.5 });
    expect(predictStockoutRiskMock).toHaveBeenCalledWith(fakeDb, "product-1");
  });

  it("GET /admin/products/{id}/dynamic-price computes a recommended price using a real FX rate and the platform defaults", async () => {
    fakeDb = createFakeDb([[{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: null, targetMarginBasisPoints: null }]]);

    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/dynamic-price"));

    expect(res.statusCode).toBe(200);
    expect(fetchFxRateMock).toHaveBeenCalledTimes(1);
    // costUsd = 67; P = (67*1.3 + 0 + 0.40) / 0.85 ≈ 102.94
    expect(JSON.parse(res.body!)).toMatchObject({ recommendedPriceUsd: 102.94, fxSource: "test" });
  });

  it("GET /admin/products/{id}/dynamic-price uses this product's saved shipping/margin overrides", async () => {
    fakeDb = createFakeDb([[{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: 1500, targetMarginBasisPoints: 5000 }]]);

    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/dynamic-price"));

    // costUsd = 67; P = (67*1.5 + 15 + 0.40) / 0.85 ≈ 136.35
    expect(JSON.parse(res.body!)).toMatchObject({ recommendedPriceUsd: 136.35 });
  });

  it("GET /admin/products/{id}/dynamic-price lets query params override the saved config for a hypothetical preview", async () => {
    fakeDb = createFakeDb([[{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: null, targetMarginBasisPoints: null }]]);

    const res = await callHandler(
      makeEvent("GET", "/admin/products/product-1/dynamic-price", { shippingUsd: "15", targetMarginRatio: "0.5" }),
    );

    expect(JSON.parse(res.body!)).toMatchObject({ recommendedPriceUsd: 136.35 });
  });

  it("GET /admin/products/{id}/dynamic-price returns 404 for a product that doesn't exist", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("GET", "/admin/products/missing/dynamic-price"));
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/products/{id}/pricing-config persists the shipping/margin overrides", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/product-1/pricing-config", {}, { shippingCostUsd: 15, targetMarginRatio: 0.5 }),
    );

    expect(res.statusCode).toBe(200);
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "pricing_config_updated",
        entityId: "product-1",
        after: { shippingCostUsdCents: 1500, targetMarginBasisPoints: 5000 },
      }),
    );
  });

  it("POST /admin/products/{id}/pricing-config clears an override back to the platform default with null", async () => {
    fakeDb = createFakeDb([]);
    await callHandler(makeEvent("POST", "/admin/products/product-1/pricing-config", {}, { shippingCostUsd: null }));

    expect(recordAuditLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ after: { shippingCostUsdCents: null } }),
    );
  });

  it("GET /admin/products/{id}/sync-trace returns the merged event/audit/error timeline for a product", async () => {
    traceSyncHistoryMock.mockResolvedValueOnce({
      productId: "product-1",
      entries: [
        { source: "inventory_event", occurredAt: new Date("2026-09-05T10:00:00Z"), summary: "ebay sale: -1 units [applied]", detail: {} },
      ],
    });
    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/sync-trace"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ productId: "product-1", entries: [{ source: "inventory_event" }] });
    expect(traceSyncHistoryMock).toHaveBeenCalledWith(fakeDb, "product-1", undefined);
  });

  it("GET /admin/products/{id}/sync-trace passes through a custom limit", async () => {
    await callHandler(makeEvent("GET", "/admin/products/product-1/sync-trace", { limit: "20" }));
    expect(traceSyncHistoryMock).toHaveBeenCalledWith(fakeDb, "product-1", 20);
  });

  it("GET /admin/products/{id}/reconstruct-inventory previews drift without writing anything", async () => {
    reconstructInventoryMock.mockResolvedValueOnce({
      reconstructedQuantity: 3,
      currentQuantity: 10,
      drifted: true,
      eventsReplayed: 2,
    });
    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/reconstruct-inventory"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ reconstructedQuantity: 3, currentQuantity: 10, drifted: true });
    expect(applyReconstructedInventoryMock).not.toHaveBeenCalled();
  });

  it("POST /admin/products/{id}/reconstruct-inventory applies drift and records an audit log entry", async () => {
    applyReconstructedInventoryMock.mockResolvedValueOnce({
      reconstructedQuantity: 3,
      currentQuantity: 10,
      drifted: true,
      eventsReplayed: 2,
      applied: true,
    });
    const res = await callHandler(makeEvent("POST", "/admin/products/product-1/reconstruct-inventory", {}, {}));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toMatchObject({ applied: true, reconstructedQuantity: 3 });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "inventory_reconstructed", entityId: "product-1" }),
    );
  });

  it("POST /admin/products/{id}/reconstruct-inventory records no audit log when there was no drift to apply", async () => {
    applyReconstructedInventoryMock.mockResolvedValueOnce({
      reconstructedQuantity: 3,
      currentQuantity: 3,
      drifted: false,
      eventsReplayed: 1,
      applied: false,
    });
    const res = await callHandler(makeEvent("POST", "/admin/products/product-1/reconstruct-inventory", {}, {}));
    expect(res.statusCode).toBe(200);
    expect(recordAuditLogMock).not.toHaveBeenCalled();
  });

  it("GET /admin/ebay/required-aspects returns eBay's real required aspects for a category", async () => {
    getRequiredItemAspectsMock.mockResolvedValueOnce(["Brand", "Type"]);
    const res = await callHandler(makeEvent("GET", "/admin/ebay/required-aspects", { categoryId: "262003" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ categoryId: "262003", requiredAspects: ["Brand", "Type"] });
    expect(getRequiredItemAspectsMock).toHaveBeenCalledWith("app-token", "262003");
  });

  it("GET /admin/ebay/required-aspects returns 400 without a categoryId", async () => {
    const res = await callHandler(makeEvent("GET", "/admin/ebay/required-aspects"));
    expect(res.statusCode).toBe(400);
  });

  it("GET /admin/ebay/category-suggestions returns eBay's real category suggestions", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("GET", "/admin/ebay/category-suggestions", { q: "silver bracelet" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ suggestions: [{ ebayCategoryId: "10364", label: "Bracelets" }] });
    expect(suggestCategoriesMock).toHaveBeenCalledWith("app-token", "silver bracelet");
  });

  it("GET /admin/ebay/category-suggestions returns 400 without a query", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("GET", "/admin/ebay/category-suggestions"));
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for an unknown route", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("GET", "/admin/nonexistent"));
    expect(res.statusCode).toBe(404);
  });
});
