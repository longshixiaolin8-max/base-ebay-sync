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

const finalizeOrderProfitMock = vi.fn();
const findStaleProductsMock = vi.fn();
const getInventoryBreakdownMock = vi.fn();
const getLiveOrderProfitMock = vi.fn();
const getSnsContentMock = vi.fn();
const listOrdersForProductMock = vi.fn();
const markSnsStatusMock = vi.fn();
const transitionOrderStatusMock = vi.fn();
const upsertSnsScriptMock = vi.fn();
const computeChannelSyncStateMock = vi.fn();
const getLatestSyncedAtMock = vi.fn().mockResolvedValue(null);
const getTenantBillingStatusMock = vi.fn().mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
const countProductsMock = vi.fn().mockResolvedValue(0);
const countProductsByStatusMock = vi.fn().mockResolvedValue(0);
const countChannelListingsByStatusMock = vi.fn().mockResolvedValue(0);
const getMonthlyAiGenerationCountMock = vi.fn().mockResolvedValue(0);
const tryReserveMonthlyAiGenerationMock = vi.fn().mockResolvedValue(true);
const releaseMonthlyAiGenerationReservationMock = vi.fn().mockResolvedValue(undefined);

class InvalidOrderTransitionErrorFake extends Error {}

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  channelListings: { productId: "productId" },
  tenants: { id: "id", ebayFulfillmentPolicyId: "ebayFulfillmentPolicyId", ebayPaymentPolicyId: "ebayPaymentPolicyId", ebayReturnPolicyId: "ebayReturnPolicyId" },
  inventoryMaster: {},
  syncErrors: { createdAt: "createdAt" },
  syncJobs: {},
  auditLog: { createdAt: "createdAt" },
  orders: {},
  aiListingDraft: { createdAt: "createdAt" },
  oauthConnections: { updatedAt: "updatedAt" },
  getLatestSyncedAt: (...args: unknown[]) => getLatestSyncedAtMock(...args),
  computeSyncConfidence: (...args: unknown[]) => computeSyncConfidenceMock(...args),
  computeDynamicSafetyStock: (...args: unknown[]) => computeDynamicSafetyStockMock(...args),
  reconstructInventory: (...args: unknown[]) => reconstructInventoryMock(...args),
  applyReconstructedInventory: (...args: unknown[]) => applyReconstructedInventoryMock(...args),
  predictStockoutRisk: (...args: unknown[]) => predictStockoutRiskMock(...args),
  traceSyncHistory: (...args: unknown[]) => traceSyncHistoryMock(...args),
  finalizeOrderProfit: (...args: unknown[]) => finalizeOrderProfitMock(...args),
  findStaleProducts: (...args: unknown[]) => findStaleProductsMock(...args),
  getInventoryBreakdown: (...args: unknown[]) => getInventoryBreakdownMock(...args),
  getLiveOrderProfit: (...args: unknown[]) => getLiveOrderProfitMock(...args),
  getSnsContent: (...args: unknown[]) => getSnsContentMock(...args),
  InvalidOrderTransitionError: InvalidOrderTransitionErrorFake,
  listOrdersForProduct: (...args: unknown[]) => listOrdersForProductMock(...args),
  markSnsStatus: (...args: unknown[]) => markSnsStatusMock(...args),
  transitionOrderStatus: (...args: unknown[]) => transitionOrderStatusMock(...args),
  upsertSnsScript: (...args: unknown[]) => upsertSnsScriptMock(...args),
  computeChannelSyncState: (...args: unknown[]) => computeChannelSyncStateMock(...args),
  getTenantBillingStatus: (...args: unknown[]) => getTenantBillingStatusMock(...args),
  countProducts: (...args: unknown[]) => countProductsMock(...args),
  countProductsByStatus: (...args: unknown[]) => countProductsByStatusMock(...args),
  countChannelListingsByStatus: (...args: unknown[]) => countChannelListingsByStatusMock(...args),
  getMonthlyAiGenerationCount: (...args: unknown[]) => getMonthlyAiGenerationCountMock(...args),
  tryReserveMonthlyAiGeneration: (...args: unknown[]) => tryReserveMonthlyAiGenerationMock(...args),
  releaseMonthlyAiGenerationReservation: (...args: unknown[]) => releaseMonthlyAiGenerationReservationMock(...args),
}));

const createAIModelClientMock = vi.fn().mockReturnValue({ generateJson: vi.fn() });
const generateSnsScriptMock = vi.fn();
const suggestStaleProductImprovementMock = vi.fn();
vi.mock("@ai-ec/ai", () => ({
  createAIModelClient: (...args: unknown[]) => createAIModelClientMock(...args),
  generateSnsScript: (...args: unknown[]) => generateSnsScriptMock(...args),
  suggestStaleProductImprovement: (...args: unknown[]) => suggestStaleProductImprovementMock(...args),
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
const requireCloudFrontOriginMock = vi.fn((_event: unknown) => null as { statusCode: number; body?: string } | null);
const billingPortalSessionsCreateMock = vi.fn().mockResolvedValue({ url: "https://billing.stripe.example/session" });
const customersRetrieveMock = vi.fn().mockResolvedValue({ deleted: false, invoice_settings: { default_payment_method: null } });
const invoicesListMock = vi.fn().mockResolvedValue({ data: [] });
const subscriptionsRetrieveMock = vi.fn().mockResolvedValue({
  cancel_at_period_end: false,
  items: { data: [{ current_period_end: 1735689600, price: { unit_amount: 980000, currency: "usd", recurring: { interval: "month" } } }] },
});
const subscriptionsUpdateMock = vi.fn().mockResolvedValue({
  cancel_at_period_end: true,
  items: { data: [{ current_period_end: 1735689600 }] },
});
const createStripeClientMock = vi.fn(() => ({
  billingPortal: { sessions: { create: billingPortalSessionsCreateMock } },
  customers: { retrieve: customersRetrieveMock },
  invoices: { list: invoicesListMock },
  subscriptions: { retrieve: subscriptionsRetrieveMock, update: subscriptionsUpdateMock },
}));
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
const subscribeToFixedPriceTransactionNotificationsMock = vi.fn().mockResolvedValue(undefined);
const listProductsMock = vi.fn().mockResolvedValue({ items: [], nextCursor: undefined });
const getRequiredItemAspectsMock = vi.fn().mockResolvedValue([]);
const getAuthorizationUrlMock = vi.fn().mockReturnValue("https://ebay.example/oauth?state=signed-state");
const createEbayAdapterMock = vi.fn((..._args: unknown[]) => ({
  createInventoryLocation: createInventoryLocationMock,
  getAuthorizationUrl: getAuthorizationUrlMock,
  getApplicationAccessToken: getApplicationAccessTokenMock,
  suggestCategories: suggestCategoriesMock,
  optInToBusinessPolicies: optInToBusinessPoliciesMock,
  createFulfillmentPolicy: createFulfillmentPolicyMock,
  createPaymentPolicy: createPaymentPolicyMock,
  createReturnPolicy: createReturnPolicyMock,
  createNotificationDestination: createNotificationDestinationMock,
  createNotificationSubscription: createNotificationSubscriptionMock,
  updateNotificationConfig: updateNotificationConfigMock,
  subscribeToFixedPriceTransactionNotifications: subscribeToFixedPriceTransactionNotificationsMock,
  listProducts: listProductsMock,
  getRequiredItemAspects: getRequiredItemAspectsMock,
}));

const fetchFxRateMock = vi.fn().mockResolvedValue({ fxRateUsdPerJpy: 0.0067, source: "test", fetchedAt: new Date() });
const getDlqUrlsMock = vi.fn(() => {
  throw new Error("Missing required environment variable: AI_GENERATE_DLQ_URL");
});
const getApproximateMessageCountMock = vi.fn().mockResolvedValue(0);
const signStateMock = vi.fn().mockReturnValue("signed-state");
const signWebhookDestinationTokenMock = vi.fn().mockReturnValue("webhook-token");
const requireEnvMock = vi.fn().mockReturnValue("https://api.example/oauth/base/callback");
const deleteOAuthConnectionsForTenantMock = vi.fn().mockResolvedValue([]);
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
  getDlqUrls: () => getDlqUrlsMock(),
  getApproximateMessageCount: (...args: unknown[]) => getApproximateMessageCountMock(...args),
  signState: (...args: unknown[]) => signStateMock(...args),
  signWebhookDestinationToken: (...args: unknown[]) => signWebhookDestinationTokenMock(...args),
  requireCloudFrontOrigin: (event: unknown) => requireCloudFrontOriginMock(event),
  requireEnv: (...args: unknown[]) => requireEnvMock(...args),
  createStripeClient: () => createStripeClientMock(),
  deleteOAuthConnectionsForTenant: (...args: unknown[]) => deleteOAuthConnectionsForTenantMock(...args),
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
    leftJoin: () => self,
    where: () => self,
    orderBy: () => self,
    limit: () => self,
    offset: () => self,
    groupBy: () => self,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return self;
}

function createFakeDb(selectResults: unknown[]) {
  let i = 0;
  return {
    select: () => chain(selectResults[i++]),
    // Same sequential slot counter as select() -- GET /admin/drafts calls selectDistinctOn
    // interleaved with plain select() calls, and both consume this same ordered list.
    selectDistinctOn: () => chain(selectResults[i++]),
    // .where() resolves to undefined when simply awaited (the vast majority of existing
    // update() call sites), but also exposes .returning() -- consumed by the handful of newer
    // routes (e.g. PATCH /admin/tenant) that need the updated row back -- drawing from this
    // same shared sequential slot list as select()/selectDistinctOn() above.
    update: vi.fn(() => ({
      set: () => ({
        where: () => ({
          returning: async () => selectResults[i++],
          then: (resolve: (v: unknown) => void) => resolve(undefined),
        }),
      }),
    })),
    insert: vi.fn(() => ({ values: async () => undefined })),
    delete: vi.fn(() => ({ where: async () => undefined })),
  };
}

const TENANT_A = "tenant-a";

function makeEvent(
  method: string,
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
  claims: Record<string, string> = { email: "admin@example.com", "custom:tenant_id": TENANT_A },
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    queryStringParameters: query,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "0.0.0.0", userAgent: "test" },
      authorizer: { jwt: { claims, scopes: [] } },
    },
  } as unknown as APIGatewayProxyEventV2;
}

describe("admin-api handler", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    recordAuditLogMock.mockClear();
    finalizeOrderProfitMock.mockClear();
    findStaleProductsMock.mockClear();
    getInventoryBreakdownMock.mockClear();
    getLiveOrderProfitMock.mockClear();
    getSnsContentMock.mockClear();
    listOrdersForProductMock.mockClear();
    markSnsStatusMock.mockClear();
    transitionOrderStatusMock.mockReset();
    upsertSnsScriptMock.mockClear();
    computeChannelSyncStateMock.mockClear();
    getLatestSyncedAtMock.mockClear().mockResolvedValue(null);
    generateSnsScriptMock.mockClear();
    suggestStaleProductImprovementMock.mockClear();
    countProductsMock.mockClear().mockResolvedValue(0);
    countProductsByStatusMock.mockClear().mockResolvedValue(0);
    countChannelListingsByStatusMock.mockClear().mockResolvedValue(0);
    getMonthlyAiGenerationCountMock.mockClear().mockResolvedValue(0);
    tryReserveMonthlyAiGenerationMock.mockClear().mockResolvedValue(true);
    releaseMonthlyAiGenerationReservationMock.mockClear();
    requireCloudFrontOriginMock.mockReturnValue(null);
  });

  it("rejects any request requireCloudFrontOrigin flags, before doing anything else (touching the DB, routing, etc.)", async () => {
    requireCloudFrontOriginMock.mockReturnValue({ statusCode: 403, body: "Direct access to this API is not permitted" });

    const res = await callHandler(makeEvent("GET", "/admin/products"));

    expect(res.statusCode).toBe(403);
  });

  it("GET /admin/products returns the product list", async () => {
    fakeDb = createFakeDb([[{ id: "p1" }, { id: "p2" }]]);
    const res = await callHandler(makeEvent("GET", "/admin/products"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ products: [{ id: "p1" }, { id: "p2" }] });
  });

  describe("GET /admin/products/list", () => {
    it("is not swallowed by the /admin/products/{id} route (the literal path segment 'list' must not be treated as a product id)", async () => {
      fakeDb = createFakeDb([[], [], [], [], [{ count: 0 }], []]);
      const res = await callHandler(makeEvent("GET", "/admin/products/list"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed).toHaveProperty("products");
      expect(parsed).toHaveProperty("kpi");
    });

    it("returns paginated rows joined with their eBay listing status, real inventory, and AI draft counts, plus catalog-wide KPI counts", async () => {
      const updatedAt = new Date("2024-04-30T13:47:00.000Z");
      fakeDb = createFakeDb([
        [], // unresolvedDrift
        [], // unresolvedDoubleSale
        [], // safetyStockBySourceChannel
        [
          {
            product: { id: "p1", sku: "SKU-TP-002", title: "スウェットパーカー", sourceChannel: "base", status: "active", images: [], priceJpy: 6980, costJpy: 2500, updatedAt },
            ebayListing: { channel: "ebay", status: "published", lastSyncedAt: null },
            inventoryRow: { safetyStockBuffer: 10, soldOut: false },
          },
        ], // rows
        [{ count: 1245 }], // totalRows (matches the current filter, independent of kpi.total)
        [{ productId: "p1", count: 3 }], // draftCountRows
        [], // trendRows
      ]);
      getInventoryBreakdownMock.mockResolvedValueOnce({ onHand: 120, reserved: 0, available: 120, safetyBuffer: 10, sellableByChannel: {} });
      countChannelListingsByStatusMock.mockResolvedValueOnce(892).mockResolvedValueOnce(79); // published, needsAttention
      countProductsByStatusMock.mockResolvedValueOnce(176).mockResolvedValueOnce(98); // draft (ai_generated), soldOut
      countProductsMock.mockResolvedValueOnce(1245); // catalog-wide total

      const res = await callHandler(makeEvent("GET", "/admin/products/list", { limit: "10", offset: "0" }));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.products).toEqual([
        expect.objectContaining({
          id: "p1",
          sku: "SKU-TP-002",
          title: "スウェットパーカー",
          sourceChannel: "base",
          status: "active",
          ebayListingStatus: "published",
          inventory: { onHand: 120, reserved: 0, available: 120, safetyBuffer: 10, sellableByChannel: {} },
          aiDraftCount: 3,
        }),
      ]);
      expect(parsed.total).toBe(1245);
      expect(parsed.kpi).toEqual({ total: 1245, published: 892, draft: 176, soldOut: 98, needsAttention: 79 });
    });

    it("reports ebayListingStatus null and aiDraftCount 0 for a product with neither, and skips the draft-count query entirely when the page is empty", async () => {
      fakeDb = createFakeDb([[], [], [], [], [{ count: 0 }], []]);
      const res = await callHandler(makeEvent("GET", "/admin/products/list"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.products).toEqual([]);
      expect(parsed.total).toBe(0);
    });

    it("clamps limit to at most 100 and offset to at least 0, rather than trusting client-supplied values directly", async () => {
      fakeDb = createFakeDb([[], [], [], [], [{ count: 0 }], []]);
      const res = await callHandler(makeEvent("GET", "/admin/products/list", { limit: "99999", offset: "-5" }));
      expect(res.statusCode).toBe(200);
    });

    it("classifies a product's diff status from unresolved sync_errors and computes catalog-wide inventory health aggregates", async () => {
      const updatedAt = new Date();
      fakeDb = createFakeDb([
        [{ productId: "p1", channel: "ebay", payload: { liveQuantity: 8, expectedQuantity: 3 } }], // unresolvedDrift (diff=5 -> attention)
        [{ productId: "p2", channel: "base" }], // unresolvedDoubleSale
        [{ sourceChannel: "base", count: 4 }], // safetyStockBySourceChannel -- applies to ebay (non-source channel)
        [
          {
            product: { id: "p1", sku: "SKU-1", title: "T1", sourceChannel: "base", status: "active", images: [], priceJpy: 1000, costJpy: 500, updatedAt },
            ebayListing: { channel: "ebay", status: "published", lastSyncedAt: updatedAt },
            inventoryRow: { safetyStockBuffer: 0, soldOut: false },
          },
          {
            product: { id: "p2", sku: "SKU-2", title: "T2", sourceChannel: "base", status: "active", images: [], priceJpy: 1000, costJpy: 500, updatedAt },
            ebayListing: null,
            inventoryRow: { safetyStockBuffer: 0, soldOut: false },
          },
        ], // rows
        [{ count: 2 }], // totalRows
        [], // draftCountRows
        [], // trendRows
      ]);
      countProductsMock.mockResolvedValueOnce(2); // catalog-wide total (used by the health-bucket "normal" remainder)

      const res = await callHandler(makeEvent("GET", "/admin/products/list"));
      const parsed = JSON.parse(res.body!);
      const byId = Object.fromEntries(parsed.products.map((p: { id: string }) => [p.id, p]));
      expect(byId.p1.diffStatus).toEqual({ code: "attention", diff: 5 });
      expect(byId.p2.diffStatus).toEqual({ code: "possible_double_sale", diff: null });
      expect(parsed.inventoryKpi).toMatchObject({
        diffCount: 2, // p1 (drift) + p2 (double-sale), distinct products
        possibleDoubleSaleCount: 1,
        reconstructPendingCount: 1,
        safetyStockAppliedCount: 4,
      });
      expect(parsed.inventoryHealthByChannel.ebay.possibleDoubleSale).toBe(0); // p2's double-sale error was recorded on channel "base"
      expect(parsed.inventoryHealthByChannel.base.possibleDoubleSale).toBe(1);
      expect(parsed.inventoryHealthByChannel.central.drift).toBe(1);
      expect(parsed.inventoryTrend).toHaveLength(7);
    });
  });

  describe("GET /admin/drafts", () => {
    it("returns an empty queue without ever calling selectDistinctOn when there are no ai_generated products", async () => {
      fakeDb = createFakeDb([[], [{ count: 0 }]]); // pendingProducts, publishedTodayRow
      const res = await callHandler(makeEvent("GET", "/admin/drafts"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.drafts).toEqual([]);
      expect(parsed.kpi).toEqual({ reviewPending: 0, needsFix: 0, publishedToday: 0, avgConfidence: 0 });
    });

    it("joins each ai_generated product with its latest draft and computes a real per-draft confidence score", async () => {
      const createdAt = new Date("2024-04-30T14:25:00.000Z");
      fakeDb = createFakeDb([
        [
          { id: "p1", title: "スタッキングマグカップ", sku: "MUG-GR-001", images: [], contentHash: "hash-A", status: "ai_generated", updatedAt: createdAt },
        ], // pendingProducts
        [
          {
            id: "d1",
            productId: "p1",
            createdAt,
            categoryCandidates: [{ ebayCategoryId: "1", label: "Home & Garden > Kitchen" }],
            confidenceFlags: { brand: "confirmed", material: "confirmed", size: "uncertain", authenticity: "unknown", condition: "confirmed" },
            needsHumanReview: true,
            sourceContentHash: "hash-A",
          },
        ], // latestDrafts
        [{ count: 8 }], // publishedTodayRow
      ]);
      countProductsByStatusMock.mockResolvedValueOnce(1);

      const res = await callHandler(makeEvent("GET", "/admin/drafts"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.drafts).toEqual([
        expect.objectContaining({
          id: "d1",
          productId: "p1",
          title: "スタッキングマグカップ",
          sku: "MUG-GR-001",
          categoryLabel: "Home & Garden > Kitchen",
          confidenceScore: 60,
          needsHumanReview: true,
          sourceMismatch: false,
        }),
      ]);
      expect(parsed.kpi).toEqual({ reviewPending: 1, needsFix: 1, publishedToday: 8, avgConfidence: 60 });
    });

    it("flags sourceMismatch when the draft's sourceContentHash no longer matches the product's current contentHash", async () => {
      const createdAt = new Date();
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T1", sku: "SKU-1", images: [], contentHash: "hash-NEW", status: "ai_generated", updatedAt: createdAt }],
        [
          {
            id: "d1",
            productId: "p1",
            createdAt,
            categoryCandidates: [],
            confidenceFlags: {},
            needsHumanReview: false,
            sourceContentHash: "hash-OLD",
          },
        ],
        [{ count: 0 }],
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/drafts"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.drafts[0]).toMatchObject({ sourceMismatch: true, confidenceScore: 100 });
    });

    it("status=needs_review filters out drafts that don't need human review", async () => {
      const createdAt = new Date();
      fakeDb = createFakeDb([
        [
          { id: "p1", title: "T1", sku: "SKU-1", images: [], contentHash: "h", status: "ai_generated", updatedAt: createdAt },
          { id: "p2", title: "T2", sku: "SKU-2", images: [], contentHash: "h", status: "ai_generated", updatedAt: createdAt },
        ],
        [
          { id: "d1", productId: "p1", createdAt, categoryCandidates: [], confidenceFlags: {}, needsHumanReview: true, sourceContentHash: "h" },
          { id: "d2", productId: "p2", createdAt, categoryCandidates: [], confidenceFlags: {}, needsHumanReview: false, sourceContentHash: "h" },
        ],
        [{ count: 0 }],
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/drafts", { status: "needs_review" }));
      const parsed = JSON.parse(res.body!);
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0].id).toBe("d1");
      // The KPI row stays scoped to the full queue, independent of the list filter above.
      expect(parsed.kpi.reviewPending).toBe(0); // countProductsByStatusMock defaults to 0 in this test
    });
  });

  describe("GET /admin/sync/connections", () => {
    it("reports disconnected channels with no expiry/last-synced when nothing has ever connected", async () => {
      fakeDb = createFakeDb([[], []]); // base oauthConnections select, ebay oauthConnections select
      computeChannelSyncStateMock.mockImplementation((..._args: unknown[]) => Promise.resolve({ channel: "base", state: "HEALTHY", reasons: [] }));
      getLatestSyncedAtMock.mockResolvedValue(null);

      const res = await callHandler(makeEvent("GET", "/admin/sync/connections"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.base).toEqual({ connected: false, externalAccountId: null, expiresAt: null, lastSyncedAt: null, state: "HEALTHY", reasons: [] });
      expect(parsed.ebay).toEqual({ connected: false, externalAccountId: null, expiresAt: null, lastSyncedAt: null, state: "HEALTHY", reasons: [] });
    });

    it("reports token expiry, last-synced time, and derived state per channel for a connected account", async () => {
      const expiresAt = new Date("2024-06-28T14:32:00.000Z");
      const lastSynced = new Date("2024-04-30T14:25:00.000Z");
      fakeDb = createFakeDb([
        [{ externalAccountId: "acct-base", expiresAt }], // base
        [], // ebay -- not connected
      ]);
      // Argument-driven rather than call-order-driven, since both channels are looked up
      // concurrently via Promise.all -- this stays correct regardless of microtask ordering.
      computeChannelSyncStateMock.mockImplementation((_db: unknown, _tenantId: unknown, channel: string) =>
        Promise.resolve(channel === "base" ? { channel, state: "DEGRADED", reasons: ["low confidence"] } : { channel, state: "HEALTHY", reasons: [] }),
      );
      getLatestSyncedAtMock.mockImplementation((_db: unknown, _tenantId: unknown, channel: string) =>
        Promise.resolve(channel === "base" ? lastSynced : null),
      );

      const res = await callHandler(makeEvent("GET", "/admin/sync/connections"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.base).toEqual({
        connected: true,
        externalAccountId: "acct-base",
        expiresAt: expiresAt.toISOString(),
        lastSyncedAt: lastSynced.toISOString(),
        state: "DEGRADED",
        reasons: ["low confidence"],
      });
      expect(parsed.ebay).toEqual({ connected: false, externalAccountId: null, expiresAt: null, lastSyncedAt: null, state: "HEALTHY", reasons: [] });
    });
  });

  describe("GET /admin/sync/jobs", () => {
    it("returns an empty queue with zeroed counts when there are no jobs", async () => {
      fakeDb = createFakeDb([[]]); // syncJobs select only -- no productIds means no second select
      const res = await callHandler(makeEvent("GET", "/admin/sync/jobs"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ jobs: [], counts: { all: 0, pending: 0, completed: 0, failed: 0 } });
    });

    it("joins job rows with their product and reports counts independent of the status filter", async () => {
      const createdAt = new Date("2024-04-30T14:24:00.000Z");
      fakeDb = createFakeDb([
        [
          { id: "j1", type: "ai_generate", productId: "p1", status: "completed", attempts: 1, idempotencyKey: "k1", payload: {}, createdAt, updatedAt: createdAt },
          { id: "j2", type: "ebay_update", productId: "p2", status: "failed", attempts: 3, idempotencyKey: "k2", payload: {}, createdAt, updatedAt: createdAt },
        ], // syncJobs
        [
          { id: "p1", title: "セラミックマグカップ", sku: "MUG-GR-001" },
          { id: "p2", title: "レザートートバッグ", sku: "TOTE-BK-789" },
        ], // productMaster
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/sync/jobs"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.counts).toEqual({ all: 2, pending: 0, completed: 1, failed: 1 });
      expect(parsed.jobs).toEqual([
        expect.objectContaining({ id: "j1", productTitle: "セラミックマグカップ", productSku: "MUG-GR-001", status: "completed" }),
        expect.objectContaining({ id: "j2", productTitle: "レザートートバッグ", productSku: "TOTE-BK-789", status: "failed" }),
      ]);
    });

    it("status filter narrows the returned jobs but not the counts", async () => {
      const createdAt = new Date();
      fakeDb = createFakeDb([
        [
          { id: "j1", type: "ai_generate", productId: null, status: "pending", attempts: 0, idempotencyKey: "k1", payload: {}, createdAt, updatedAt: createdAt },
          { id: "j2", type: "ebay_update", productId: null, status: "failed", attempts: 1, idempotencyKey: "k2", payload: {}, createdAt, updatedAt: createdAt },
        ],
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/sync/jobs", { status: "failed" }));
      const parsed = JSON.parse(res.body!);
      expect(parsed.jobs).toHaveLength(1);
      expect(parsed.jobs[0].id).toBe("j2");
      expect(parsed.counts).toEqual({ all: 2, pending: 1, completed: 0, failed: 1 });
    });
  });

  describe("POST /admin/sync/jobs/{id}/retry", () => {
    it("returns 404 when the job doesn't exist", async () => {
      fakeDb = createFakeDb([[]]);
      const res = await callHandler(makeEvent("POST", "/admin/sync/jobs/j1/retry"));
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 when the job isn't currently failed", async () => {
      fakeDb = createFakeDb([[{ id: "j1", status: "pending" }]]);
      const res = await callHandler(makeEvent("POST", "/admin/sync/jobs/j1/retry"));
      expect(res.statusCode).toBe(400);
    });

    it("resets a failed job to pending and records an audit log entry", async () => {
      fakeDb = createFakeDb([[{ id: "j1", status: "failed" }]]);
      const res = await callHandler(makeEvent("POST", "/admin/sync/jobs/j1/retry"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ status: "pending" });
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({ actor: "admin@example.com", action: "sync_job_retried", entityType: "sync_job", entityId: "j1" }),
      );
    });
  });

  describe("POST /admin/sync/jobs/bulk-retry", () => {
    it("returns 400 when ids is missing or empty", async () => {
      const res = await callHandler(makeEvent("POST", "/admin/sync/jobs/bulk-retry", {}, { ids: [] }));
      expect(res.statusCode).toBe(400);
    });

    it("retries only the (already-failed) jobs the query matched, one audit log entry each", async () => {
      fakeDb = createFakeDb([
        [
          { id: "j1", status: "failed" },
          { id: "j2", status: "failed" },
        ],
      ]);
      const res = await callHandler(makeEvent("POST", "/admin/sync/jobs/bulk-retry", {}, { ids: ["j1", "j2", "j3"] }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ retried: 2 });
      expect(recordAuditLogMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("GET /admin/sync/pipeline", () => {
    it("returns real per-stage counts for the given date range", async () => {
      fakeDb = createFakeDb([
        [{ count: 128 }], // fetched (productMaster)
        [{ count: 96 }], // transformed (aiListingDraft)
        [{ count: 72 }], // published (channelListings)
        [{ count: 4 }], // pendingTransform (syncJobs ai_generate pending)
        [{ count: 2 }], // pendingPublish (syncJobs ebay_update/channel_inventory_push pending)
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/sync/pipeline", { from: "2024-04-01", to: "2024-04-30" }));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.fetched).toEqual({ count: 128 });
      expect(parsed.transformed).toEqual({ count: 96, pending: 4 });
      expect(parsed.published).toEqual({ count: 72, pending: 2 });
    });

    it("defaults to a trailing 30-day window when no from/to is given", async () => {
      fakeDb = createFakeDb([[{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }], [{ count: 0 }]]);
      const res = await callHandler(makeEvent("GET", "/admin/sync/pipeline"));
      const parsed = JSON.parse(res.body!);
      const diffDays = (new Date(parsed.to).getTime() - new Date(parsed.from).getTime()) / (24 * 60 * 60 * 1000);
      expect(diffDays).toBeCloseTo(30, 0);
    });
  });

  it("GET /admin/products/{id} returns 404 when the product doesn't exist", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("GET", "/admin/products/missing-id"));
    expect(res.statusCode).toBe(404);
  });

  it("GET /admin/products/{id} returns product + listings + inventory + null draft when none exists", async () => {
    fakeDb = createFakeDb([[{ id: "p1" }], [{ channel: "ebay" }], [{ quantity: 3 }], []]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      product: { id: "p1" },
      listings: [{ channel: "ebay" }],
      inventory: { quantity: 3 },
      draft: null,
    });
  });

  it("GET /admin/products/{id} includes the latest AI draft when one exists", async () => {
    fakeDb = createFakeDb([
      [{ id: "p1" }],
      [{ channel: "ebay" }],
      [{ quantity: 3 }],
      [{ id: "draft-1", titleEn: "Vintage Ring", itemSpecifics: { Brand: "Unbranded" } }],
    ]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).draft).toEqual({ id: "draft-1", titleEn: "Vintage Ring", itemSpecifics: { Brand: "Unbranded" } });
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
      { type: "ebay_publish", tenantId: TENANT_A, productId: "p1" },
      `${TENANT_A}:ebay-publish:p1`,
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
      { type: "ai_generate", tenantId: TENANT_A, productId: "p1" },
      expect.stringContaining(`${TENANT_A}:retry:e1:`),
    );
  });

  it("POST /admin/products/{id}/draft-item-specifics returns 404 when no draft exists", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-item-specifics", {}, { itemSpecifics: { Brand: "Tiffany" } }));
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/products/{id}/draft-item-specifics returns 400 without an itemSpecifics body", async () => {
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-item-specifics", {}, {}));
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/products/{id}/draft-item-specifics merges the human-provided values into the existing draft", async () => {
    fakeDb = createFakeDb([[{ id: "draft-1", itemSpecifics: { Brand: null, Type: "Bracelet" } }]]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/p1/draft-item-specifics", {}, { itemSpecifics: { Brand: "Tiffany" } }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ productId: "p1", itemSpecifics: { Brand: "Tiffany", Type: "Bracelet" } });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "ai_draft_item_specifics_corrected", entityId: "draft-1" }),
    );
  });

  it("POST /admin/products/{id}/draft-price returns 400 for a non-positive or non-numeric price", async () => {
    const res1 = await callHandler(makeEvent("POST", "/admin/products/p1/draft-price", {}, { suggestedPriceUsd: -5 }));
    expect(res1.statusCode).toBe(400);
    const res2 = await callHandler(makeEvent("POST", "/admin/products/p1/draft-price", {}, {}));
    expect(res2.statusCode).toBe(400);
  });

  it("POST /admin/products/{id}/draft-price returns 404 when no draft exists", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-price", {}, { suggestedPriceUsd: 24.99 }));
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/products/{id}/draft-price stores the price in cents and records an audit log entry", async () => {
    fakeDb = createFakeDb([[{ id: "draft-1", suggestedPriceUsd: 1999 }]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-price", {}, { suggestedPriceUsd: 24.99 }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ productId: "p1", suggestedPriceUsdCents: 2499 });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "ai_draft_price_corrected", entityId: "draft-1", after: { suggestedPriceUsdCents: 2499 } }),
    );
  });

  it("POST /admin/products/{id}/draft-seo-keywords returns 400 when seoKeywords isn't a string array", async () => {
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-seo-keywords", {}, { seoKeywords: "not-an-array" }));
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/products/{id}/draft-seo-keywords replaces the keyword list, trimming and de-duplicating", async () => {
    fakeDb = createFakeDb([[{ id: "draft-1", seoKeywords: ["old"] }]]);
    const res = await callHandler(
      makeEvent("POST", "/admin/products/p1/draft-seo-keywords", {}, { seoKeywords: [" mug ", "mug", "ceramic", ""] }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ productId: "p1", seoKeywords: ["mug", "ceramic"] });
    expect(recordAuditLogMock).toHaveBeenCalledWith(
      fakeDb,
      expect.objectContaining({ action: "ai_draft_seo_keywords_corrected", entityId: "draft-1" }),
    );
  });

  it("POST /admin/products/{id}/draft-notes returns 404 when no draft exists", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-notes", {}, { internalNotes: "追加撮影を依頼済み" }));
    expect(res.statusCode).toBe(404);
  });

  it("POST /admin/products/{id}/draft-notes saves a trimmed note, and null clears it", async () => {
    fakeDb = createFakeDb([[{ id: "draft-1" }]]);
    const res = await callHandler(makeEvent("POST", "/admin/products/p1/draft-notes", {}, { internalNotes: "  追加撮影を依頼済み  " }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ productId: "p1", internalNotes: "追加撮影を依頼済み" });

    fakeDb = createFakeDb([[{ id: "draft-1" }]]);
    const res2 = await callHandler(makeEvent("POST", "/admin/products/p1/draft-notes", {}, { internalNotes: "" }));
    expect(JSON.parse(res2.body!)).toEqual({ productId: "p1", internalNotes: null });
  });

  it("GET /admin/sync-errors filters by productId when provided", async () => {
    fakeDb = createFakeDb([[{ error: { id: "e1", productId: "p1" }, productTitle: null, productSku: null, jobType: null }]]);
    const res = await callHandler(makeEvent("GET", "/admin/sync-errors", { resolved: "false", productId: "p1" }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      syncErrors: [{ id: "e1", productId: "p1", productTitle: null, productSku: null, jobType: null }],
    });
  });

  it("GET /admin/sync-errors includes the joined product name/SKU and job type when available", async () => {
    fakeDb = createFakeDb([
      [
        {
          error: { id: "e1", productId: "p1", jobId: "j1", errorCode: "inventory_sync_failed" },
          productTitle: "レザートートバッグ",
          productSku: "TOTE-BK-789",
          jobType: "ebay_update",
        },
      ],
    ]);
    const res = await callHandler(makeEvent("GET", "/admin/sync-errors", { resolved: "false" }));
    expect(JSON.parse(res.body!)).toEqual({
      syncErrors: [
        {
          id: "e1",
          productId: "p1",
          jobId: "j1",
          errorCode: "inventory_sync_failed",
          productTitle: "レザートートバッグ",
          productSku: "TOTE-BK-789",
          jobType: "ebay_update",
        },
      ],
    });
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

  it("POST /admin/ebay/webhook-setup creates a per-tenant tokened destination and subscription", async () => {
    process.env.EBAY_WEBHOOK_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/notifications";
    getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid", clientSecret: "ebay-csecret", webhookVerificationToken: "verify-me" });
    signWebhookDestinationTokenMock.mockClear().mockReturnValue("webhook-token");
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/webhook-setup", {}, { topicId: "LISTING", alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body!)).toEqual({ destinationId: "dest-1", subscriptionId: "sub-1" });
    expect(updateNotificationConfigMock).toHaveBeenCalledWith("token", "ops@example.com");
    // Production-readiness fix: registers each tenant's own /{token}-suffixed destination
    // URL, not the shared bare one every tenant used to collide on -- see ebay-webhook's
    // handleNotification, which now reads this same token back to resolve the real tenant.
    expect(signWebhookDestinationTokenMock).toHaveBeenCalledWith("ebay-csecret", TENANT_A);
    expect(createNotificationDestinationMock).toHaveBeenCalledWith(
      "token",
      "AI EC Platform",
      "https://api.example.com/webhooks/ebay/notifications/webhook-token",
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

  it("POST /admin/ebay/platform-notification-setup subscribes to FixedPriceTransaction at a per-tenant, signed-token endpoint URL", async () => {
    process.env.EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/platform-notifications";
    signWebhookDestinationTokenMock.mockClear().mockReturnValue("webhook-token");
    getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid", clientSecret: "ebay-csecret", ruName: "ru" });
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, { alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(201);
    // 大量notification abuse対策 (round 14): the registered destination is no longer the
    // bare, fully-guessable static path -- a per-tenant HMAC token is appended, minted from
    // this tenant's own authenticated session, never from client input.
    expect(signWebhookDestinationTokenMock).toHaveBeenCalledWith("ebay-csecret", TENANT_A);
    expect(subscribeToFixedPriceTransactionNotificationsMock).toHaveBeenCalledWith(
      "token",
      "https://api.example.com/webhooks/ebay/platform-notifications/webhook-token",
      "ops@example.com",
    );
  });

  it("POST /admin/ebay/platform-notification-setup mints a different token for a different tenant", async () => {
    process.env.EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/platform-notifications";
    subscribeToFixedPriceTransactionNotificationsMock.mockClear();
    signWebhookDestinationTokenMock.mockClear();
    signWebhookDestinationTokenMock.mockReturnValueOnce("token-for-a").mockReturnValueOnce("token-for-b");
    fakeDb = createFakeDb([]);

    await callHandler(makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, { alertEmail: "a@example.com" }));
    await callHandler(
      makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, { alertEmail: "b@example.com" }, { email: "b@example.com", "custom:tenant_id": "tenant-b" }),
    );

    const urls = subscribeToFixedPriceTransactionNotificationsMock.mock.calls.map((c) => c[1] as string);
    expect(urls[0]).toContain("token-for-a");
    expect(urls[1]).toContain("token-for-b");
    expect(urls[0]).not.toBe(urls[1]);
  });

  it("POST /admin/ebay/platform-notification-setup returns 400 without an alertEmail", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, {}));
    expect(res.statusCode).toBe(400);
  });

  it("POST /admin/ebay/platform-notification-setup returns 500 when the endpoint URL is not configured", async () => {
    delete process.env.EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL;
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, { alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(500);
  });

  it("POST /admin/ebay/platform-notification-setup returns 409 when no eBay account is connected", async () => {
    process.env.EBAY_PLATFORM_NOTIFICATION_ENDPOINT_URL = "https://api.example.com/webhooks/ebay/platform-notifications";
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    fakeDb = createFakeDb([]);
    const res = await callHandler(
      makeEvent("POST", "/admin/ebay/platform-notification-setup", {}, { alertEmail: "ops@example.com" }),
    );
    expect(res.statusCode).toBe(409);
  });

  it("POST /admin/ebay/policies opts in, creates the three business policies, and persists their ids", async () => {
    fakeDb = createFakeDb([[]]); // no existing policy ids yet
    const res = await callHandler(makeEvent("POST", "/admin/ebay/policies"));
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body!)).toEqual({
      fulfillmentPolicyId: "fp-1",
      paymentPolicyId: "pp-1",
      returnPolicyId: "rp-1",
    });
    expect(optInToBusinessPoliciesMock).toHaveBeenCalledWith("token");
    expect((fakeDb as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(expect.anything());
  });

  it("POST /admin/ebay/policies is idempotent: reuses already-persisted ids instead of creating a second set", async () => {
    optInToBusinessPoliciesMock.mockClear();
    createFulfillmentPolicyMock.mockClear();
    fakeDb = createFakeDb([
      [{ ebayFulfillmentPolicyId: "fp-existing", ebayPaymentPolicyId: "pp-existing", ebayReturnPolicyId: "rp-existing" }],
    ]);
    const res = await callHandler(makeEvent("POST", "/admin/ebay/policies"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      fulfillmentPolicyId: "fp-existing",
      paymentPolicyId: "pp-existing",
      returnPolicyId: "rp-existing",
      alreadyConfigured: true,
    });
    expect(optInToBusinessPoliciesMock).not.toHaveBeenCalled();
    expect(createFulfillmentPolicyMock).not.toHaveBeenCalled();
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

  it("GET /admin/ebay/unmanaged-listings forwards the real description/images from eBay, with no fabricated price", async () => {
    listProductsMock.mockResolvedValueOnce({
      items: [
        {
          externalId: "hand-listed-sku",
          title: "Pre-existing listing",
          descriptionHtml: "<p>real eBay description</p>",
          images: ["https://ebay.example/img1.jpg"],
        },
      ],
      nextCursor: undefined,
    });
    fakeDb = createFakeDb([[], []]);

    const res = await callHandler(makeEvent("GET", "/admin/ebay/unmanaged-listings"));
    expect(res.statusCode).toBe(200);
    const { unmanagedListings } = JSON.parse(res.body!) as { unmanagedListings: Array<Record<string, unknown>> };
    expect(unmanagedListings[0]).toMatchObject({
      descriptionHtml: "<p>real eBay description</p>",
      images: ["https://ebay.example/img1.jpg"],
    });
    expect(unmanagedListings[0]).not.toHaveProperty("priceJpy");
    expect(unmanagedListings[0]).not.toHaveProperty("price");
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
    expect(computeSyncConfidenceMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "ebay", undefined);
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
    expect(computeDynamicSafetyStockMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "product-1", "ebay");
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
    expect(predictStockoutRiskMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "product-1");
  });

  it("GET /admin/products/{id}/dynamic-price computes a recommended price using a real FX rate and the platform defaults", async () => {
    fakeDb = createFakeDb([
      [{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: null, targetMarginBasisPoints: null }],
      [{ defaultShippingCostJpyIntl: null, defaultTargetMarginBasisPoints: null }], // tenant pricing defaults -- none set
    ]);

    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/dynamic-price"));

    expect(res.statusCode).toBe(200);
    expect(fetchFxRateMock).toHaveBeenCalledTimes(1);
    // costUsd = 67; P = (67*1.3 + 0 + 0.40) / 0.85 ≈ 102.94
    expect(JSON.parse(res.body!)).toMatchObject({ recommendedPriceUsd: 102.94, fxSource: "test" });
  });

  it("GET /admin/products/{id}/dynamic-price uses this product's saved shipping/margin overrides", async () => {
    fakeDb = createFakeDb([
      [{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: 1500, targetMarginBasisPoints: 5000 }],
      [{ defaultShippingCostJpyIntl: null, defaultTargetMarginBasisPoints: null }],
    ]);

    const res = await callHandler(makeEvent("GET", "/admin/products/product-1/dynamic-price"));

    // costUsd = 67; P = (67*1.5 + 15 + 0.40) / 0.85 ≈ 136.35
    expect(JSON.parse(res.body!)).toMatchObject({ recommendedPriceUsd: 136.35 });
  });

  it("GET /admin/products/{id}/dynamic-price lets query params override the saved config for a hypothetical preview", async () => {
    fakeDb = createFakeDb([
      [{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: null, targetMarginBasisPoints: null }],
      [{ defaultShippingCostJpyIntl: null, defaultTargetMarginBasisPoints: null }],
    ]);

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

  describe("POST /admin/products/{id}/apply-dynamic-price", () => {
    it("returns 404 for a product that doesn't exist", async () => {
      fakeDb = createFakeDb([[]]);
      const res = await callHandler(makeEvent("POST", "/admin/products/missing/apply-dynamic-price"));
      expect(res.statusCode).toBe(404);
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it("returns 409 when the product has no published eBay listing", async () => {
      fakeDb = createFakeDb([[{ id: "product-1", priceJpy: 10000 }], [{ status: "pending_approval", externalId: null }]]);
      const res = await callHandler(makeEvent("POST", "/admin/products/product-1/apply-dynamic-price"));
      expect(res.statusCode).toBe(409);
      expect(JSON.parse(res.body!)).toEqual({ error: "not_published_to_ebay" });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it("returns 404 when the product has no AI draft yet", async () => {
      fakeDb = createFakeDb([[{ id: "product-1", priceJpy: 10000 }], [{ status: "published", externalId: "ext-1" }], []]);
      const res = await callHandler(makeEvent("POST", "/admin/products/product-1/apply-dynamic-price"));
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body!)).toEqual({ error: "no_draft_for_product" });
      expect(enqueueMock).not.toHaveBeenCalled();
    });

    it("writes the recommended price onto the draft, enqueues ebay_update, and records an audit log entry", async () => {
      fakeDb = createFakeDb([
        [{ id: "product-1", priceJpy: 10000, shippingCostUsdCents: null, targetMarginBasisPoints: null }],
        [{ status: "published", externalId: "ext-1" }],
        [{ id: "draft-1", suggestedPriceUsd: null }],
        [{ defaultShippingCostJpyIntl: null, defaultTargetMarginBasisPoints: null }], // tenant pricing defaults -- none set
      ]);

      const res = await callHandler(makeEvent("POST", "/admin/products/product-1/apply-dynamic-price"));

      expect(res.statusCode).toBe(202);
      // costUsd = 67; P = (67*1.3 + 0 + 0.40) / 0.85 ≈ 102.94
      expect(JSON.parse(res.body!)).toMatchObject({ status: "update_queued", priceUsd: 102.94 });
      expect((fakeDb as { update: ReturnType<typeof vi.fn> }).update).toHaveBeenCalledWith(expect.anything());
      expect(enqueueMock).toHaveBeenCalledWith(
        "ebay-sync-url",
        { type: "ebay_update", tenantId: TENANT_A, productId: "product-1" },
        `${TENANT_A}:ebay-update:product-1:apply-price-10294`,
      );
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({
          actor: "admin@example.com",
          action: "dynamic_price_applied",
          entityId: "product-1",
          before: { suggestedPriceUsd: null },
          after: { suggestedPriceUsd: 10294 },
        }),
      );
    });
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
    expect(traceSyncHistoryMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "product-1", undefined);
  });

  it("GET /admin/products/{id}/sync-trace passes through a custom limit", async () => {
    await callHandler(makeEvent("GET", "/admin/products/product-1/sync-trace", { limit: "20" }));
    expect(traceSyncHistoryMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "product-1", 20);
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

  it("POST /admin/products/{id}/reconstruct-inventory resolves the product's open inventory_drift errors once applied", async () => {
    applyReconstructedInventoryMock.mockResolvedValueOnce({
      reconstructedQuantity: 3,
      currentQuantity: 10,
      drifted: true,
      eventsReplayed: 2,
      applied: true,
    });
    const updateMock = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
    fakeDb = { ...createFakeDb([]), update: updateMock };
    await callHandler(makeEvent("POST", "/admin/products/product-1/reconstruct-inventory", {}, {}));
    expect(updateMock).toHaveBeenCalled();
  });

  it("POST /admin/products/{id}/reconstruct-inventory does not touch sync_errors when there was no drift", async () => {
    applyReconstructedInventoryMock.mockResolvedValueOnce({
      reconstructedQuantity: 3,
      currentQuantity: 3,
      drifted: false,
      eventsReplayed: 1,
      applied: false,
    });
    const updateMock = vi.fn(() => ({ set: () => ({ where: async () => undefined }) }));
    fakeDb = { ...createFakeDb([]), update: updateMock };
    await callHandler(makeEvent("POST", "/admin/products/product-1/reconstruct-inventory", {}, {}));
    expect(updateMock).not.toHaveBeenCalled();
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

  it("GET /admin/products/{id}/preflight-check returns 404 when no draft exists", async () => {
    fakeDb = createFakeDb([[]]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1/preflight-check"));
    expect(res.statusCode).toBe(404);
  });

  it("GET /admin/products/{id}/preflight-check reports missing required aspects before approval", async () => {
    fakeDb = createFakeDb([
      [{ id: "draft-1", categoryCandidates: [{ ebayCategoryId: "262003", label: "Jewelry" }], itemSpecifics: { Brand: null, Type: "Bracelet" } }],
    ]);
    getRequiredItemAspectsMock.mockResolvedValueOnce(["Brand", "Type", "Metal"]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1/preflight-check"));
    expect(res.statusCode).toBe(200);
    // Brand is null but eBay's own "Unbranded" fallback fills it (applyStandardAspectFallbacks),
    // so only the aspect with no correct generic fallback (Metal) should be reported missing.
    expect(JSON.parse(res.body!)).toEqual({ categoryId: "262003", missingAspects: ["Metal"] });
  });

  it("GET /admin/products/{id}/preflight-check returns no missing aspects once everything required is present", async () => {
    fakeDb = createFakeDb([
      [{ id: "draft-1", categoryCandidates: [{ ebayCategoryId: "262003", label: "Jewelry" }], itemSpecifics: { Brand: "Tiffany", Type: "Bracelet" } }],
    ]);
    getRequiredItemAspectsMock.mockResolvedValueOnce(["Brand", "Type"]);
    const res = await callHandler(makeEvent("GET", "/admin/products/p1/preflight-check"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ categoryId: "262003", missingAspects: [] });
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

  describe("commercial-features round", () => {
    it("GET /admin/orders lists orders, optionally filtered by status, enriched with product info, live profit, and possible_double_sale/margin flags", async () => {
      const order = {
        id: "o1",
        productId: "p1",
        channel: "ebay",
        status: "SHIPPED",
        placedAt: new Date("2024-04-30T14:23:00.000Z"),
        profitFinalizedAt: null,
        finalizedNetProfitUsdCents: null,
        returnRequestedAt: null,
      };
      fakeDb = createFakeDb([
        [{ order, product: { id: "p1", sku: "SKU-1", title: "Product One", images: [] } }], // rows
        [{ count: 1 }], // totalRows
        [], // recentOrdersForBaseline
        [], // unresolvedDoubleSale
      ]);
      getLiveOrderProfitMock.mockReturnValue({ revenueUsdCents: 3600, costUsdCents: 2000, netProfitUsdCents: 1600, profitMarginBasisPoints: 4444 });

      const res = await callHandler(makeEvent("GET", "/admin/orders", { status: "SHIPPED" }));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.orders).toEqual([
        expect.objectContaining({
          id: "o1",
          product: { id: "p1", sku: "SKU-1", title: "Product One", images: [] },
          profit: { finalized: false, revenueUsdCents: 3600, costUsdCents: 2000, netProfitUsdCents: 1600, profitMarginBasisPoints: 4444 },
          hasPossibleDoubleSale: false,
          belowAverageMargin: false,
        }),
      ]);
      expect(parsed.total).toBe(1);
      expect(parsed.avgProfitMarginBasisPoints).toBeNull();
    });

    it("GET /admin/orders flags a row whose product has an unresolved possible_double_sale error", async () => {
      const order = {
        id: "o1",
        productId: "p1",
        channel: "ebay",
        status: "SHIPPED",
        placedAt: new Date(),
        profitFinalizedAt: null,
        finalizedNetProfitUsdCents: null,
        returnRequestedAt: null,
      };
      fakeDb = createFakeDb([
        [{ order, product: { id: "p1", sku: "SKU-1", title: "Product One", images: [] } }],
        [{ count: 1 }],
        [],
        [{ productId: "p1" }], // unresolvedDoubleSale
      ]);
      getLiveOrderProfitMock.mockReturnValue({ revenueUsdCents: 3600, costUsdCents: 2000, netProfitUsdCents: 1600, profitMarginBasisPoints: 4444 });

      const res = await callHandler(makeEvent("GET", "/admin/orders"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.orders[0].hasPossibleDoubleSale).toBe(true);
    });

    it("GET /admin/orders returns an empty list with zero total when there are no matching orders", async () => {
      fakeDb = createFakeDb([[], [{ count: 0 }], [], []]);
      const res = await callHandler(makeEvent("GET", "/admin/orders"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.orders).toEqual([]);
      expect(parsed.total).toBe(0);
    });

    describe("GET /admin/orders/summary", () => {
      it("computes trailing-24h vs previous-24h KPIs, a daily trend, and a per-channel profit breakdown from real orders", async () => {
        const order = {
          id: "o1",
          channel: "ebay",
          placedAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago -- inside last24h, not prev24h
          profitFinalizedAt: null,
          finalizedNetProfitUsdCents: null,
          returnRequestedAt: null,
          costJpy: 1200,
          shippingCostJpy: 750,
          ebayFeeUsdCents: 230,
          paymentFeeUsdCents: 0,
        };
        fakeDb = createFakeDb([[order]]);
        getLiveOrderProfitMock.mockReturnValue({ revenueUsdCents: 3600, costUsdCents: 2180, netProfitUsdCents: 1420, profitMarginBasisPoints: 3944 });

        const res = await callHandler(makeEvent("GET", "/admin/orders/summary"));
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body!);
        // usdPerJpy is the test suite's fixed 0.0067 (fetchFxRateMock's default) -- these are
        // exact usdCentsToJpy(cents) = round(cents/100/0.0067) conversions.
        expect(parsed.kpi.orderCount).toEqual({ value: 1, deltaPct: null }); // previous window has 0 orders
        expect(parsed.kpi.revenueJpy).toEqual({ value: 5373, deltaPct: null });
        expect(parsed.kpi.ebayRevenueJpy).toEqual({ value: 5373, deltaPct: null });
        expect(parsed.kpi.netProfitJpy).toEqual({ value: 2119, deltaPct: null });
        expect(parsed.kpi.returnCount).toEqual({ value: 0, deltaAbs: 0 });
        expect(parsed.trend).toHaveLength(30);
        expect(parsed.trend.reduce((sum: number, d: { orderCount: number }) => sum + d.orderCount, 0)).toBe(1);
        expect(parsed.channelBreakdown.ebay).toEqual({ revenueJpy: 5373, costJpy: 1200, feesJpy: 343, shippingJpy: 750, profitJpy: 2119 });
        expect(parsed.channelBreakdown.base).toEqual({ revenueJpy: 0, costJpy: 0, feesJpy: 0, shippingJpy: 0, profitJpy: 0 });
      });

      it("accepts a custom ?days= window", async () => {
        fakeDb = createFakeDb([[]]);
        const res = await callHandler(makeEvent("GET", "/admin/orders/summary", { days: "7" }));
        const parsed = JSON.parse(res.body!);
        expect(parsed.days).toBe(7);
        expect(parsed.trend).toHaveLength(7);
      });
    });

    describe("GET /admin/analytics/summary", () => {
      it("returns zeroed KPIs, an empty category/heatmap, and no insights when there's no data", async () => {
        fakeDb = createFakeDb([[], [], [], [{ total: 0 }], []]);
        const res = await callHandler(makeEvent("GET", "/admin/analytics/summary"));
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body!);
        expect(parsed.kpi.monthlyRevenueJpy).toEqual({ value: 0, deltaPct: 0 });
        expect(parsed.kpi.ebayListingConversionRate).toEqual({ value: null, deltaPct: null });
        expect(parsed.kpi.turnoverRate).toEqual({ value: null, deltaPct: null });
        expect(parsed.kpi.syncSuccessRate).toEqual({ value: 100, deltaPct: null });
        expect(parsed.kpi.aiDraftApprovalRate).toEqual({ value: null, deltaPct: null });
        expect(parsed.trend).toHaveLength(30);
        expect(parsed.channelByMonth).toHaveLength(4);
        expect(parsed.categoryRevenue).toEqual([]);
        expect(parsed.turnoverHeatmap.weeks).toHaveLength(8);
        expect(parsed.turnoverHeatmap.categories).toEqual([]);
        expect(parsed.funnel).toEqual({ generated: 0, published: 0, ordered: 0 });
        expect(parsed.insights).toEqual([]);
      });

      it("computes real category revenue (via the AI draft category proxy), a profit waterfall, and a turnover-rate approximation from real orders", async () => {
        const order = {
          id: "o1",
          productId: "p1",
          channel: "ebay",
          placedAt: new Date(),
          quantity: 2,
          profitFinalizedAt: null,
          finalizedNetProfitUsdCents: null,
          costJpy: 1000,
          shippingCostJpy: 500,
          ebayFeeUsdCents: 200,
          paymentFeeUsdCents: 50,
        };
        fakeDb = createFakeDb([
          [order], // relevantOrders
          [], // draftsInRange
          [], // approvalLogs
          [{ total: 10 }], // inventoryTotalRows
          [], // syncErrorsInRange
          [{ productId: "p1", categoryCandidates: [{ ebayCategoryId: "1", label: "ホビー" }], createdAt: new Date() }], // productDraftsForCategory
        ]);
        getLiveOrderProfitMock.mockReturnValue({ revenueUsdCents: 3600, costUsdCents: 1750, netProfitUsdCents: 1350, profitMarginBasisPoints: 3750 });
        countChannelListingsByStatusMock.mockResolvedValueOnce(5); // ebayPublishedCount

        const res = await callHandler(makeEvent("GET", "/admin/analytics/summary"));
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body!);
        // usdPerJpy is the fixed test-suite default (0.0067) -- usdCentsToJpy(cents) = round(cents/100/0.0067).
        expect(parsed.categoryRevenue).toEqual([{ category: "ホビー", revenueJpy: 5373 }]);
        expect(parsed.profitWaterfall).toEqual({ revenueJpy: 5373, costJpy: 1000, feesJpy: 373, shippingJpy: 500, profitJpy: 2015 });
        expect(parsed.kpi.turnoverRate.value).toBe(0.2); // 2 units sold / 10 in stock
        expect(parsed.kpi.ebayListingConversionRate.value).toBeCloseTo(20, 0); // 1 ebay order / 5 published listings
        expect(parsed.turnoverHeatmap.categories).toEqual(["ホビー"]);
      });
    });

    describe("GET /admin/analytics/products", () => {
      it("ranks products by revenue by default, with a real turnover-rate approximation", async () => {
        const order = { id: "o1", productId: "p1", channel: "ebay", placedAt: new Date(), quantity: 3, profitFinalizedAt: null, finalizedNetProfitUsdCents: null };
        fakeDb = createFakeDb([[order], [{ id: "p1", sku: "SKU-1", title: "Product One", images: [] }], [{ productId: "p1", quantity: 15 }]]);
        getLiveOrderProfitMock.mockReturnValue({ revenueUsdCents: 3600, costUsdCents: 2000, netProfitUsdCents: 1600, profitMarginBasisPoints: 4444 });

        const res = await callHandler(makeEvent("GET", "/admin/analytics/products"));
        expect(res.statusCode).toBe(200);
        const parsed = JSON.parse(res.body!);
        expect(parsed.products).toEqual([
          expect.objectContaining({ productId: "p1", title: "Product One", sku: "SKU-1", orderCount: 1, turnoverRate: 0.2 }),
        ]);
      });

      it("returns an empty ranking when there are no orders in the window", async () => {
        fakeDb = createFakeDb([[]]);
        const res = await callHandler(makeEvent("GET", "/admin/analytics/products"));
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body!).products).toEqual([]);
      });
    });

    it("GET /admin/products/{id}/orders lists that product's orders", async () => {
      listOrdersForProductMock.mockResolvedValueOnce([{ id: "o1" }]);
      const res = await callHandler(makeEvent("GET", "/admin/products/p1/orders"));
      expect(res.statusCode).toBe(200);
      expect(listOrdersForProductMock).toHaveBeenCalledWith(expect.anything(), TENANT_A, "p1");
    });

    it("GET /admin/orders/{id}/profit returns a finalized snapshot when already finalized", async () => {
      fakeDb = createFakeDb([[{ id: "o1", profitFinalizedAt: new Date("2026-01-01"), finalizedNetProfitUsdCents: 500 }]]);
      const res = await callHandler(makeEvent("GET", "/admin/orders/o1/profit"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ finalized: true, netProfitUsdCents: 500 });
      expect(getLiveOrderProfitMock).not.toHaveBeenCalled();
    });

    it("GET /admin/orders/{id}/profit computes live profit when not yet finalized", async () => {
      fakeDb = createFakeDb([[{ id: "o1", profitFinalizedAt: null }]]);
      getLiveOrderProfitMock.mockReturnValueOnce({ revenueUsdCents: 5000, costUsdCents: 4000, netProfitUsdCents: 1000, profitMarginBasisPoints: 2000 });
      const res = await callHandler(makeEvent("GET", "/admin/orders/o1/profit"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ finalized: false, netProfitUsdCents: 1000 });
    });

    it("POST /admin/orders/{id}/status applies a valid transition", async () => {
      transitionOrderStatusMock.mockResolvedValueOnce({ id: "o1", status: "PAID" });
      const res = await callHandler(makeEvent("POST", "/admin/orders/o1/status", {}, { status: "PAID" }));
      expect(res.statusCode).toBe(200);
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "order_status_changed", entityId: "o1" }),
      );
    });

    it("POST /admin/orders/{id}/status returns 400 for an unrecognized status value", async () => {
      const res = await callHandler(makeEvent("POST", "/admin/orders/o1/status", {}, { status: "NOT_A_REAL_STATUS" }));
      expect(res.statusCode).toBe(400);
      expect(transitionOrderStatusMock).not.toHaveBeenCalled();
    });

    it("POST /admin/orders/{id}/status returns 409 for an illegal transition", async () => {
      transitionOrderStatusMock.mockRejectedValueOnce(new InvalidOrderTransitionErrorFake("bad transition"));
      const res = await callHandler(makeEvent("POST", "/admin/orders/o1/status", {}, { status: "SHIPPED" }));
      expect(res.statusCode).toBe(409);
    });

    it("POST /admin/orders/{id}/finalize-profit snapshots the profit", async () => {
      finalizeOrderProfitMock.mockResolvedValueOnce({ id: "o1", finalizedNetProfitUsdCents: 1000 });
      const res = await callHandler(makeEvent("POST", "/admin/orders/o1/finalize-profit"));
      expect(res.statusCode).toBe(200);
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "order_profit_finalized", entityId: "o1" }),
      );
    });

    it("POST /admin/products/{id}/purchase-info requires costJpy", async () => {
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/purchase-info", {}, {}));
      expect(res.statusCode).toBe(400);
    });

    it("POST /admin/products/{id}/purchase-info records the cost and audit log", async () => {
      fakeDb = createFakeDb([]);
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/purchase-info", {}, { costJpy: 3000 }));
      expect(res.statusCode).toBe(200);
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "product_purchased", entityId: "p1" }),
      );
    });

    it("GET /admin/products/{id}/inventory-breakdown returns 404 when the product/inventory row is missing", async () => {
      getInventoryBreakdownMock.mockResolvedValueOnce(null);
      const res = await callHandler(makeEvent("GET", "/admin/products/p1/inventory-breakdown"));
      expect(res.statusCode).toBe(404);
    });

    it("GET /admin/products/{id}/inventory-breakdown returns the breakdown", async () => {
      getInventoryBreakdownMock.mockResolvedValueOnce({ productId: "p1", onHand: 5, reserved: 1, available: 5, safetyBuffer: 1, sellableByChannel: {} });
      const res = await callHandler(makeEvent("GET", "/admin/products/p1/inventory-breakdown"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ onHand: 5, reserved: 1 });
    });

    it("GET /admin/stale-products lists stale products", async () => {
      findStaleProductsMock.mockResolvedValueOnce([{ productId: "p1", daysListed: 45, level: "stale_30" }]);
      const res = await callHandler(makeEvent("GET", "/admin/stale-products"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ staleProducts: [{ productId: "p1", daysListed: 45, level: "stale_30" }] });
    });

    it("POST /admin/products/{id}/stale-suggestion returns 404 when the product doesn't exist", async () => {
      fakeDb = createFakeDb([[]]);
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/stale-suggestion"));
      expect(res.statusCode).toBe(404);
    });

    it("POST /admin/products/{id}/stale-suggestion generates a live AI suggestion without persisting it", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [], createdAt: new Date(Date.now() - 45 * 86400000) }],
      ]);
      suggestStaleProductImprovementMock.mockResolvedValueOnce({ suggestion: "Cut the price.", suggestedActions: ["Cut price by 15%"] });
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/stale-suggestion"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toMatchObject({ productId: "p1", suggestion: "Cut the price." });
      expect(tryReserveMonthlyAiGenerationMock).toHaveBeenCalledWith(fakeDb, TENANT_A, 100);
      expect(releaseMonthlyAiGenerationReservationMock).not.toHaveBeenCalled();
    });

    it("POST /admin/products/{id}/stale-suggestion returns 429 once the tenant is at its plan's monthly AI limit", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [], createdAt: new Date() }],
      ]);
      tryReserveMonthlyAiGenerationMock.mockResolvedValueOnce(false);
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/stale-suggestion"));
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body!)).toEqual({ error: "ai_quota_exceeded", limit: 100 });
      expect(suggestStaleProductImprovementMock).not.toHaveBeenCalled();
    });

    it("POST /admin/products/{id}/stale-suggestion releases the reservation when the AI call fails", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [], createdAt: new Date() }],
      ]);
      suggestStaleProductImprovementMock.mockRejectedValueOnce(new Error("model provider timed out"));
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/stale-suggestion"));
      expect(res.statusCode).toBe(500);
      expect(releaseMonthlyAiGenerationReservationMock).toHaveBeenCalledWith(fakeDb, TENANT_A);
    });

    it("GET /admin/products/{id}/sns returns the sns content row (or null)", async () => {
      getSnsContentMock.mockResolvedValueOnce(null);
      const res = await callHandler(makeEvent("GET", "/admin/products/p1/sns"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ snsContent: null });
    });

    it("POST /admin/products/{id}/sns/script generates and persists a script", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [] }],
      ]);
      generateSnsScriptMock.mockResolvedValueOnce({ scriptText: "Check this out!", needsHumanReview: true, reviewNotes: [] });
      upsertSnsScriptMock.mockResolvedValueOnce({ productId: "p1", scriptText: "Check this out!" });
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/sns/script"));
      expect(res.statusCode).toBe(200);
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "sns_script_generated", entityId: "p1" }),
      );
      expect(tryReserveMonthlyAiGenerationMock).toHaveBeenCalledWith(fakeDb, TENANT_A, 100);
      expect(releaseMonthlyAiGenerationReservationMock).not.toHaveBeenCalled();
    });

    it("POST /admin/products/{id}/sns/script returns 429 once the tenant is at its plan's monthly AI limit", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [] }],
      ]);
      tryReserveMonthlyAiGenerationMock.mockResolvedValueOnce(false);
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/sns/script"));
      expect(res.statusCode).toBe(429);
      expect(JSON.parse(res.body!)).toEqual({ error: "ai_quota_exceeded", limit: 100 });
      expect(generateSnsScriptMock).not.toHaveBeenCalled();
    });

    it("POST /admin/products/{id}/sns/script releases the reservation when generation or persistence fails", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", title: "T", descriptionJa: "d", brand: null, material: null, sizeLabel: null, priceJpy: 3000, images: [] }],
      ]);
      generateSnsScriptMock.mockRejectedValueOnce(new Error("model provider timed out"));
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/sns/script"));
      expect(res.statusCode).toBe(500);
      expect(releaseMonthlyAiGenerationReservationMock).toHaveBeenCalledWith(fakeDb, TENANT_A);
    });

    it("POST /admin/products/{id}/sns/status marks posting flags", async () => {
      markSnsStatusMock.mockResolvedValueOnce({ productId: "p1", videoCreated: true });
      const res = await callHandler(makeEvent("POST", "/admin/products/p1/sns/status", {}, { videoCreated: true }));
      expect(res.statusCode).toBe(200);
      expect(markSnsStatusMock).toHaveBeenCalledWith(expect.anything(), TENANT_A, "p1", { videoCreated: true });
    });

    it("GET /admin/sync/state requires a channel", async () => {
      const res = await callHandler(makeEvent("GET", "/admin/sync/state"));
      expect(res.statusCode).toBe(400);
    });

    it("GET /admin/sync/state returns the computed state", async () => {
      computeChannelSyncStateMock.mockResolvedValueOnce({ channel: "ebay", state: "HEALTHY", reasons: [] });
      const res = await callHandler(makeEvent("GET", "/admin/sync/state", { channel: "ebay" }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ channel: "ebay", state: "HEALTHY", reasons: [] });
    });

    it("GET /admin/oauth/status reports both channels as not connected for a brand-new tenant", async () => {
      fakeDb = createFakeDb([[]]);
      listConnectedAccountIdsMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const res = await callHandler(makeEvent("GET", "/admin/oauth/status"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ base: false, ebay: false, ebayPoliciesConfigured: false });
    });

    it("GET /admin/oauth/status reports a channel connected once an account id exists for it", async () => {
      fakeDb = createFakeDb([[]]);
      listConnectedAccountIdsMock.mockResolvedValueOnce(["base-acct-1"]).mockResolvedValueOnce([]);
      const res = await callHandler(makeEvent("GET", "/admin/oauth/status"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ base: true, ebay: false, ebayPoliciesConfigured: false });
    });

    it("GET /admin/oauth/status reports ebayPoliciesConfigured once the onboarding policies step has run", async () => {
      fakeDb = createFakeDb([[{ ebayFulfillmentPolicyId: "fp-1" }]]);
      listConnectedAccountIdsMock.mockResolvedValueOnce(["base-acct-1"]).mockResolvedValueOnce(["ebay-acct-1"]);
      const res = await callHandler(makeEvent("GET", "/admin/oauth/status"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ base: true, ebay: true, ebayPoliciesConfigured: true });
    });

    it("GET /admin/slo aggregates sync confidence, drift count, AI failure rate, and recent auto-recovery events", async () => {
      fakeDb = createFakeDb([
        [{ id: "e1" }], // inventory_drift errors
        [{ id: "e2" }], // ai_generate_failed errors
        [], // ai_listing_draft rows in window
        [{ id: "a1", action: "dlq_redrive_started" }], // recent auto-recovery events
      ]);
      const res = await callHandler(makeEvent("GET", "/admin/slo"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.inventoryInconsistencyCount).toBe(1);
      expect(parsed.aiFailureRate).toEqual({ failureCount: 1, attemptCount: 1, rate: 1 });
      expect(parsed.recentAutoRecoveryEvents).toEqual([{ id: "a1", action: "dlq_redrive_started" }]);
      // DLQ URL env vars aren't configured in this test environment -- omitted, not a failure.
      expect(parsed.dlqDepths).toBeNull();
    });

    it("GET /admin/commerce-dashboard aggregates per-product commerce data into one view", async () => {
      const lastSyncedAt = new Date("2026-09-01T00:00:00Z");
      fakeDb = createFakeDb([
        [
          {
            id: "p1",
            sku: "sku-1",
            title: "T1",
            status: "active",
            createdAt: new Date(Date.now() - 10 * 86400000),
            images: ["https://example.com/photo.jpg"],
          },
        ], // products
        [{ channel: "ebay", status: "published", lastSyncedAt }], // channel_listings for p1
      ]);
      getInventoryBreakdownMock.mockResolvedValueOnce({ onHand: 5, reserved: 0, available: 5, safetyBuffer: 0, sellableByChannel: { ebay: 5 } });
      listOrdersForProductMock.mockResolvedValueOnce([]);
      getSnsContentMock.mockResolvedValueOnce(null);

      const res = await callHandler(makeEvent("GET", "/admin/commerce-dashboard"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.products).toHaveLength(1);
      expect(parsed.products[0]).toMatchObject({
        productId: "p1",
        sku: "sku-1",
        channelStatus: { ebay: "published" },
        images: ["https://example.com/photo.jpg"],
        lastSyncedAt: { ebay: lastSyncedAt.toISOString() },
        revenueUsdCents: 0,
        netProfitUsdCents: 0,
        daysListed: 10,
        staleLevel: "fresh",
        hasReturn: false,
      });
      expect(parsed.products[0].costUsdCents).toBeNull();
    });

    it("GET /admin/commerce-dashboard surfaces the eBay channel's real last-synced price, converted to USD", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", sku: "sku-1", title: "T1", status: "active", createdAt: new Date(), images: [] }],
        [{ channel: "ebay", status: "published", lastSyncedPriceJpy: 13000 }],
      ]);
      getInventoryBreakdownMock.mockResolvedValueOnce({ onHand: 1, reserved: 0, available: 1, safetyBuffer: 0, sellableByChannel: {} });
      listOrdersForProductMock.mockResolvedValueOnce([]);
      getSnsContentMock.mockResolvedValueOnce(null);
      fetchFxRateMock.mockResolvedValueOnce({ fxRateUsdPerJpy: 0.0067, source: "test", fetchedAt: new Date() });

      const res = await callHandler(makeEvent("GET", "/admin/commerce-dashboard"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.products[0].currentEbayPriceUsdCents).toBe(Math.round(13000 * 0.0067 * 100));
    });

    it("GET /admin/commerce-dashboard reports a null current eBay price before any sync has ever succeeded", async () => {
      fakeDb = createFakeDb([
        [{ id: "p1", sku: "sku-1", title: "T1", status: "draft", createdAt: new Date(), images: [] }],
        [],
      ]);
      getInventoryBreakdownMock.mockResolvedValueOnce(null);
      listOrdersForProductMock.mockResolvedValueOnce([]);
      getSnsContentMock.mockResolvedValueOnce(null);

      const res = await callHandler(makeEvent("GET", "/admin/commerce-dashboard"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.products[0].currentEbayPriceUsdCents).toBeNull();
    });

    it("GET /admin/commerce-dashboard converts a product's real cost_jpy to costUsdCents, using the current FX rate", async () => {
      fakeDb = createFakeDb([
        [
          {
            id: "p1",
            sku: "sku-1",
            title: "T1",
            status: "active",
            createdAt: new Date(),
            images: [],
            costJpy: 3000,
          },
        ],
        [],
      ]);
      getInventoryBreakdownMock.mockResolvedValueOnce({ onHand: 1, reserved: 0, available: 1, safetyBuffer: 0, sellableByChannel: {} });
      listOrdersForProductMock.mockResolvedValueOnce([]);
      getSnsContentMock.mockResolvedValueOnce(null);
      fetchFxRateMock.mockResolvedValueOnce({ fxRateUsdPerJpy: 0.0067, source: "test", fetchedAt: new Date() });

      const res = await callHandler(makeEvent("GET", "/admin/commerce-dashboard"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.products[0].costUsdCents).toBe(Math.round(3000 * 0.0067 * 100));
    });

    it("GET /admin/dashboard/summary aggregates this-month/last-month KPIs, a daily trend, recent orders, and inventory", async () => {
      const now = new Date();
      const thisMonthPlacedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12));
      fakeDb = createFakeDb([
        [
          {
            id: "o1",
            productId: "p1",
            channel: "ebay",
            status: "DELIVERED",
            placedAt: thisMonthPlacedAt,
            profitFinalizedAt: null,
            finalizedNetProfitUsdCents: null,
          },
        ], // relevantOrders
        [{ id: "p1", title: "T1", sku: "sku-1" }], // products
        [{ channel: "base", lastSyncedAt: "2024-04-30T14:24:00.000Z" }], // lastSyncedRows
      ]);
      countChannelListingsByStatusMock.mockResolvedValueOnce(5);
      getLiveOrderProfitMock.mockReturnValueOnce({ revenueUsdCents: 10000, costUsdCents: 6000, netProfitUsdCents: 4000, profitMarginBasisPoints: 4000 });
      getInventoryBreakdownMock.mockResolvedValueOnce({ productId: "p1", onHand: 5, reserved: 1, available: 2, safetyBuffer: 3, sellableByChannel: {} });

      const res = await callHandler(makeEvent("GET", "/admin/dashboard/summary"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.currentMonth).toMatchObject({
        revenueUsdCents: 10000,
        netProfitUsdCents: 4000,
        orderCount: 1,
        ordersByChannel: { ebay: 1 },
      });
      expect(parsed.previousMonth).toMatchObject({ revenueUsdCents: 0, netProfitUsdCents: 0, orderCount: 0 });
      expect(parsed.recentOrders).toEqual([
        expect.objectContaining({ id: "o1", productTitle: "T1", sku: "sku-1", channel: "ebay", revenueUsdCents: 10000 }),
      ]);
      expect(parsed.inventory).toEqual({ totalAvailable: 2, lowStockCount: 1 });
      expect(parsed.trend).toHaveLength(14);
      expect(parsed.ebayPublishedCount).toBe(5);
      expect(parsed.lastSyncedAt).toEqual({ base: "2024-04-30T14:24:00.000Z", ebay: null });
    });

    it("GET /admin/dashboard/summary's last24h window only counts orders placed in the trailing 24h, separately from the calendar-day trend", async () => {
      const now = new Date();
      const withinLast24h = new Date(now.getTime() - 2 * 60 * 60 * 1000);
      const overADayAgo = new Date(now.getTime() - 30 * 60 * 60 * 1000);
      fakeDb = createFakeDb([
        [
          { id: "recent", productId: "p1", channel: "base", status: "PAID", placedAt: withinLast24h, profitFinalizedAt: null, finalizedNetProfitUsdCents: null },
          { id: "old", productId: "p1", channel: "base", status: "PAID", placedAt: overADayAgo, profitFinalizedAt: null, finalizedNetProfitUsdCents: null },
        ], // relevantOrders
        [{ id: "p1", title: "T1", sku: "sku-1" }], // products
        [], // lastSyncedRows
      ]);
      getLiveOrderProfitMock
        .mockReturnValueOnce({ revenueUsdCents: 500, costUsdCents: 100, netProfitUsdCents: 400, profitMarginBasisPoints: 8000 })
        .mockReturnValueOnce({ revenueUsdCents: 900, costUsdCents: 100, netProfitUsdCents: 800, profitMarginBasisPoints: 8888 });
      getInventoryBreakdownMock.mockResolvedValueOnce(null);

      const res = await callHandler(makeEvent("GET", "/admin/dashboard/summary"));
      const parsed = JSON.parse(res.body!);
      expect(parsed.last24h).toEqual({ revenueUsdCents: 500, orderCount: 1 });
      expect(parsed.ebayPublishedCount).toBe(0);
      expect(parsed.lastSyncedAt).toEqual({ base: null, ebay: null });
    });

    it("GET /admin/dashboard/summary returns zeroed KPIs and an empty recent-orders list with no real orders yet", async () => {
      fakeDb = createFakeDb([[], [], []]);

      const res = await callHandler(makeEvent("GET", "/admin/dashboard/summary"));
      expect(res.statusCode).toBe(200);
      const parsed = JSON.parse(res.body!);
      expect(parsed.currentMonth).toMatchObject({ revenueUsdCents: 0, orderCount: 0, profitMarginBasisPoints: null });
      expect(parsed.recentOrders).toEqual([]);
      expect(parsed.inventory).toEqual({ totalAvailable: 0, lowStockCount: 0 });
      expect(parsed.last24h).toEqual({ revenueUsdCents: 0, orderCount: 0 });
      expect(parsed.ebayPublishedCount).toBe(0);
      expect(parsed.lastSyncedAt).toEqual({ base: null, ebay: null });
      expect(getLiveOrderProfitMock).not.toHaveBeenCalled();
    });
  });

  describe("tenant isolation", () => {
    it("returns 403 rather than defaulting to any tenant when the custom:tenant_id claim is missing", async () => {
      fakeDb = createFakeDb([]);
      const res = await callHandler(makeEvent("GET", "/admin/products", {}, undefined, { email: "admin@example.com" }));
      expect(res.statusCode).toBe(403);
    });

    it("GET /admin/products filters by the caller's own tenantId, not just status/limit", async () => {
      fakeDb = createFakeDb([[]]);
      await callHandler(makeEvent("GET", "/admin/products"));
      // `where` is opaque in this fakeDb, but the route only ever builds it from
      // eq(productMaster.tenantId, tenantId) -- exercised for real by packages/db's own
      // tenant-scoping tests; this proves the route at least reaches that call with a tenant
      // in scope, i.e. it didn't short-circuit before tenantIdFromEvent ran.
      expect(getDbMock).toHaveBeenCalled();
    });
  });

  describe("GET /admin/oauth/{channel}/authorize-url", () => {
    it("mints a signed state from the caller's own tenantId and returns eBay's consent URL", async () => {
      fakeDb = createFakeDb([]);
      getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid", clientSecret: "csecret", ruName: "ru-1" });
      const res = await callHandler(makeEvent("GET", "/admin/oauth/ebay/authorize-url"));
      expect(res.statusCode).toBe(200);
      expect(signStateMock).toHaveBeenCalledWith("csecret", TENANT_A);
      expect(getAuthorizationUrlMock).toHaveBeenCalledWith("signed-state", "ru-1");
      expect(JSON.parse(res.body!)).toEqual({ url: "https://ebay.example/oauth?state=signed-state" });
    });

    it("does the same for BASE -- this authenticated route is now the sole entry point for both channels", async () => {
      fakeDb = createFakeDb([]);
      signStateMock.mockClear();
      getAppCredentialsMock.mockResolvedValueOnce({ clientId: "base-cid", clientSecret: "base-csecret" });

      const res = await callHandler(makeEvent("GET", "/admin/oauth/base/authorize-url"));

      expect(res.statusCode).toBe(200);
      expect(signStateMock).toHaveBeenCalledWith("base-csecret", TENANT_A);
      const { url } = JSON.parse(res.body!) as { url: string };
      const parsed = new URL(url);
      expect(parsed.searchParams.get("client_id")).toBe("base-cid");
      expect(parsed.searchParams.get("state")).toBe("signed-state");
      expect(parsed.searchParams.get("redirect_uri")).toBe("https://api.example/oauth/base/callback");
    });

    it("never accepts a client-supplied tenantId -- the state is always minted from the caller's own authenticated tenantId", async () => {
      fakeDb = createFakeDb([]);
      signStateMock.mockClear();
      getAppCredentialsMock.mockResolvedValueOnce({ clientId: "cid", clientSecret: "csecret", ruName: "ru-1" });

      await callHandler(makeEvent("GET", "/admin/oauth/ebay/authorize-url", { tenantId: "some-other-tenant" }));

      // The query string is simply never read for this -- tenantId always comes from
      // tenantIdFromEvent(event)'s authenticated Cognito claims (TENANT_A in these tests).
      expect(signStateMock).toHaveBeenCalledWith("csecret", TENANT_A);
    });

    it("returns 400 for a channel that isn't implemented yet, rather than falling through to a generic 404", async () => {
      fakeDb = createFakeDb([]);
      const res = await callHandler(makeEvent("GET", "/admin/oauth/shopify/authorize-url"));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body!)).toEqual({ error: "unknown_channel" });
    });
  });

  describe("billing", () => {
    beforeEach(() => {
      getTenantBillingStatusMock.mockClear();
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
      billingPortalSessionsCreateMock.mockClear();
    });

    it("blocks every other route with 402 when the tenant isn't active", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "pending_payment", stripeCustomerId: null });
      fakeDb = createFakeDb([]);

      const res = await callHandler(makeEvent("GET", "/admin/products"));

      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body!)).toEqual({ error: "billing_inactive", status: "pending_payment", gracePeriodEndsAt: null });
    });

    it("GET /admin/billing/status is reachable even when the tenant is inactive, and reports Stripe test-mode", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "past_due", stripeCustomerId: "cus_1" });
      getAppCredentialsMock.mockResolvedValueOnce({ secretKey: "sk_test_abc123" });

      const res = await callHandler(makeEvent("GET", "/admin/billing/status"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ plan: "standard", status: "past_due", testMode: true, gracePeriodEndsAt: null });
    });

    it("GET /admin/billing/status reports testMode false for a live Stripe secret key", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: "cus_1" });
      getAppCredentialsMock.mockResolvedValueOnce({ secretKey: "sk_live_abc123" });

      const res = await callHandler(makeEvent("GET", "/admin/billing/status"));

      expect(JSON.parse(res.body!)).toEqual({ plan: "standard", status: "active", testMode: false, gracePeriodEndsAt: null });
    });

    it("GET /admin/billing/status still succeeds with testMode:true when the Stripe secret isn't configured (not JSON)", async () => {
      // This route is billing-exempt and checked on every page load -- a not-yet-populated
      // Stripe secret (still holding CDK's generated placeholder, not real credentials) must
      // never break it, only the testMode hint.
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });
      getAppCredentialsMock.mockRejectedValueOnce(new SyntaxError("Unexpected token in JSON"));

      const res = await callHandler(makeEvent("GET", "/admin/billing/status"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ plan: "standard", status: "active", testMode: true, gracePeriodEndsAt: null });
    });

    it("GET /admin/billing/status reports gracePeriodEndsAt for a canceled_grace tenant", async () => {
      const endsAt = new Date("2026-03-01T00:00:00Z");
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "canceled_grace",
        stripeCustomerId: "cus_1",
        gracePeriodEndsAt: endsAt,
      });

      const res = await callHandler(makeEvent("GET", "/admin/billing/status"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        plan: "standard",
        status: "canceled_grace",
        testMode: true,
        gracePeriodEndsAt: endsAt.toISOString(),
      });
    });

    it("allows GET routes for a canceled_grace tenant still within its grace period", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "canceled_grace",
        stripeCustomerId: "cus_1",
        gracePeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      fakeDb = createFakeDb([]);

      const res = await callHandler(makeEvent("GET", "/admin/products"));

      expect(res.statusCode).not.toBe(402);
    });

    it("blocks writes with 402 for a canceled_grace tenant still within its grace period", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "canceled_grace",
        stripeCustomerId: "cus_1",
        gracePeriodEndsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });

      const res = await callHandler(makeEvent("POST", "/admin/products/p1/approve-ebay-listing"));

      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body!)).toMatchObject({ error: "billing_inactive", status: "canceled_grace" });
    });

    it("blocks GET routes with 402 once a canceled_grace tenant's grace period has ended", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "canceled_grace",
        stripeCustomerId: "cus_1",
        gracePeriodEndsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      });

      const res = await callHandler(makeEvent("GET", "/admin/products"));

      expect(res.statusCode).toBe(402);
      expect(JSON.parse(res.body!)).toMatchObject({ error: "billing_inactive", status: "canceled_grace" });
    });

    it("GET /admin/billing/details returns the real Stripe payment method, invoices, and subscription period", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "active",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      });
      getAppCredentialsMock.mockResolvedValueOnce({ secretKey: "sk_test_abc123" });
      customersRetrieveMock.mockResolvedValueOnce({
        deleted: false,
        email: "demo@example.com",
        invoice_settings: {
          default_payment_method: { card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 } },
        },
      });
      invoicesListMock.mockResolvedValueOnce({
        data: [
          {
            id: "in_1",
            number: "INV-202404",
            amount_paid: 980000,
            created: 1735689600,
            status: "paid",
            hosted_invoice_url: "https://invoice.stripe.example/in_1",
          },
        ],
      });
      subscriptionsRetrieveMock.mockResolvedValueOnce({
        status: "active",
        cancel_at_period_end: false,
        items: {
          data: [
            {
              current_period_end: 1738368000,
              price: { unit_amount: 980000, currency: "usd", recurring: { interval: "month" } },
            },
          ],
        },
      });

      const res = await callHandler(makeEvent("GET", "/admin/billing/details"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        paymentMethod: { brand: "visa", last4: "4242", expMonth: 12, expYear: 2028 },
        invoices: [
          {
            id: "in_1",
            number: "INV-202404",
            amountUsdCents: 980000,
            createdAt: new Date(1735689600 * 1000).toISOString(),
            status: "paid",
            hostedInvoiceUrl: "https://invoice.stripe.example/in_1",
          },
        ],
        subscription: {
          currentPeriodEnd: new Date(1738368000 * 1000).toISOString(),
          cancelAtPeriodEnd: false,
          priceAmount: 980000,
          priceCurrency: "usd",
          priceInterval: "month",
          trialEnd: null,
        },
        billingEmail: "demo@example.com",
      });
    });

    it("GET /admin/billing/details reports trialEnd while the free trial is running", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "active",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      });
      getAppCredentialsMock.mockResolvedValueOnce({ secretKey: "sk_test_abc123" });
      customersRetrieveMock.mockResolvedValueOnce({ deleted: false, invoice_settings: {} });
      invoicesListMock.mockResolvedValueOnce({ data: [] });
      subscriptionsRetrieveMock.mockResolvedValueOnce({
        status: "trialing",
        trial_end: 1738368000,
        cancel_at_period_end: false,
        items: {
          data: [
            {
              current_period_end: 1740960000,
              price: { unit_amount: 980000, currency: "usd", recurring: { interval: "month" } },
            },
          ],
        },
      });

      const res = await callHandler(makeEvent("GET", "/admin/billing/details"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!).subscription).toMatchObject({ trialEnd: new Date(1738368000 * 1000).toISOString() });
    });

    it("GET /admin/billing/details returns 400 when the (active) tenant somehow has no Stripe customer id", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });

      const res = await callHandler(makeEvent("GET", "/admin/billing/details"));

      expect(res.statusCode).toBe(400);
    });

    it("POST /admin/billing/cancel schedules cancellation at period end and records an audit log entry", async () => {
      getTenantBillingStatusMock.mockResolvedValue({
        plan: "standard",
        status: "active",
        stripeCustomerId: "cus_1",
        stripeSubscriptionId: "sub_1",
      });
      getAppCredentialsMock.mockResolvedValueOnce({ secretKey: "sk_test_abc123" });
      subscriptionsUpdateMock.mockResolvedValueOnce({
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: 1738368000 }] },
      });

      const res = await callHandler(makeEvent("POST", "/admin/billing/cancel"));

      expect(res.statusCode).toBe(200);
      expect(subscriptionsUpdateMock).toHaveBeenCalledWith("sub_1", { cancel_at_period_end: true });
      expect(JSON.parse(res.body!)).toEqual({
        cancelAtPeriodEnd: true,
        currentPeriodEnd: new Date(1738368000 * 1000).toISOString(),
      });
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: "subscription_cancel_scheduled", entityType: "tenant" }),
      );
    });

    it("GET /admin/tenant returns the tenant's real registered name and settings fields", async () => {
      fakeDb = createFakeDb([
        [{ id: TENANT_A, name: "Acme Inc", address: null, timezone: "Asia/Tokyo", language: "ja", contactEmail: null }],
      ]);

      const res = await callHandler(makeEvent("GET", "/admin/tenant"));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ id: TENANT_A, name: "Acme Inc", address: null, timezone: "Asia/Tokyo", language: "ja", contactEmail: null });
    });

    it("PATCH /admin/tenant updates the tenant info card fields and records an audit log entry", async () => {
      fakeDb = createFakeDb([
        [{ id: TENANT_A, name: "New Name", address: "東京都渋谷区神宮前1-2-3", timezone: "Asia/Tokyo", language: "ja", contactEmail: "demo@example.com" }],
      ]);

      const res = await callHandler(
        makeEvent("PATCH", "/admin/tenant", {}, { name: "New Name", address: "東京都渋谷区神宮前1-2-3", contactEmail: "demo@example.com" }),
      );

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        id: TENANT_A,
        name: "New Name",
        address: "東京都渋谷区神宮前1-2-3",
        timezone: "Asia/Tokyo",
        language: "ja",
        contactEmail: "demo@example.com",
      });
      expect(recordAuditLogMock).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ action: "tenant_settings_updated", entityType: "tenant" }));
    });

    it("GET /admin/tenant/notification-preferences defaults every toggle to true when nothing has been saved yet", async () => {
      fakeDb = createFakeDb([[{ notificationPreferences: null }]]);
      const res = await callHandler(makeEvent("GET", "/admin/tenant/notification-preferences"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        inventoryDiffAlert: true,
        aiDraftCompleted: true,
        billingNotice: true,
        oauthExpiryNotice: true,
        importantNotice: true,
      });
    });

    it("PATCH /admin/tenant/notification-preferences merges a partial update onto the existing saved preferences", async () => {
      fakeDb = createFakeDb([[{ notificationPreferences: { inventoryDiffAlert: false } }]]);
      const res = await callHandler(makeEvent("PATCH", "/admin/tenant/notification-preferences", {}, { aiDraftCompleted: false }));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({
        inventoryDiffAlert: false,
        aiDraftCompleted: false,
        billingNotice: true,
        oauthExpiryNotice: true,
        importantNotice: true,
      });
    });

    it("GET /admin/tenant/pricing-defaults returns the tenant's stored defaults", async () => {
      fakeDb = createFakeDb([[{ defaultShippingCostJpyDomestic: 800, defaultShippingCostJpyIntl: 2000, defaultTargetMarginBasisPoints: 2000 }]]);
      const res = await callHandler(makeEvent("GET", "/admin/tenant/pricing-defaults"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ defaultShippingCostJpyDomestic: 800, defaultShippingCostJpyIntl: 2000, defaultTargetMarginBasisPoints: 2000 });
    });

    it("PATCH /admin/tenant/pricing-defaults converts a percent input into stored basis points", async () => {
      fakeDb = createFakeDb([[{ defaultShippingCostJpyDomestic: 800, defaultShippingCostJpyIntl: 2000, defaultTargetMarginBasisPoints: 2000 }]]);
      const res = await callHandler(
        makeEvent("PATCH", "/admin/tenant/pricing-defaults", {}, { defaultShippingCostJpyDomestic: 800, defaultShippingCostJpyIntl: 2000, defaultTargetMarginPercent: 20 }),
      );
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ defaultShippingCostJpyDomestic: 800, defaultShippingCostJpyIntl: 2000, defaultTargetMarginBasisPoints: 2000 });
      expect(recordAuditLogMock).toHaveBeenCalledWith(fakeDb, expect.objectContaining({ action: "pricing_defaults_updated", entityType: "tenant" }));
    });

    it("POST /admin/oauth/{channel}/disconnect deletes the connection row AND its Secrets Manager token, and records an audit log entry", async () => {
      fakeDb = createFakeDb([]);
      deleteOAuthConnectionsForTenantMock.mockClear();
      const res = await callHandler(makeEvent("POST", "/admin/oauth/ebay/disconnect"));
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body!)).toEqual({ channel: "ebay", disconnected: true });
      // Must go through deleteOAuthConnectionsForTenant (which deletes the underlying
      // Secrets Manager secret too), never a bare db.delete() that would silently orphan a
      // still-live OAuth token the tenant believes it has revoked.
      expect(deleteOAuthConnectionsForTenantMock).toHaveBeenCalledWith(fakeDb, TENANT_A, "ebay");
      expect(recordAuditLogMock).toHaveBeenCalledWith(
        fakeDb,
        expect.objectContaining({ actor: "admin@example.com", action: "oauth_disconnected", entityType: "oauth_connection", entityId: "ebay" }),
      );
    });

    it("POST /admin/oauth/{channel}/disconnect returns 400 for a channel that isn't implemented yet", async () => {
      fakeDb = createFakeDb([]);
      deleteOAuthConnectionsForTenantMock.mockClear();
      const res = await callHandler(makeEvent("POST", "/admin/oauth/amazon/disconnect"));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body!)).toEqual({ error: "unknown_channel" });
      expect(deleteOAuthConnectionsForTenantMock).not.toHaveBeenCalled();
    });

    it("POST /admin/billing/portal-session is reachable even when the tenant is inactive, and returns the Stripe portal URL", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "past_due", stripeCustomerId: "cus_1" });

      const res = await callHandler(makeEvent("POST", "/admin/billing/portal-session"));

      expect(res.statusCode).toBe(200);
      expect(billingPortalSessionsCreateMock).toHaveBeenCalledWith({
        customer: "cus_1",
        return_url: "https://api.example/oauth/base/callback/billing",
      });
      expect(JSON.parse(res.body!)).toEqual({ url: "https://billing.stripe.example/session" });
    });

    it("POST /admin/billing/portal-session returns 400 when the tenant has no Stripe customer yet", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "active", stripeCustomerId: null });

      const res = await callHandler(makeEvent("POST", "/admin/billing/portal-session"));

      expect(res.statusCode).toBe(400);
      expect(billingPortalSessionsCreateMock).not.toHaveBeenCalled();
    });

    it("allows normal routes through once the tenant is active again", async () => {
      fakeDb = createFakeDb([[]]);

      const res = await callHandler(makeEvent("GET", "/admin/products"));

      expect(res.statusCode).toBe(200);
    });

    it("GET /admin/usage returns product and AI-generation usage against the plan's limits", async () => {
      countProductsMock.mockResolvedValueOnce(12);
      getMonthlyAiGenerationCountMock.mockResolvedValueOnce(3);

      const res = await callHandler(makeEvent("GET", "/admin/usage"));

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body!);
      expect(body.products).toEqual({ used: 12, limit: 300 });
      expect(body.aiGenerations).toMatchObject({ used: 3, limit: 100 });
      expect(typeof body.aiGenerations.periodStart).toBe("string");
    });

    it("GET /admin/usage is blocked (402) when the tenant isn't active, like every other non-billing route", async () => {
      getTenantBillingStatusMock.mockResolvedValue({ plan: "standard", status: "pending_payment", stripeCustomerId: null });

      const res = await callHandler(makeEvent("GET", "/admin/usage"));

      expect(res.statusCode).toBe(402);
    });
  });
});
