import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ai-ec/db", () => ({
  productMaster: {},
  channelListings: { productId: "productId" },
  inventoryMaster: {},
  syncErrors: {},
  syncJobs: {},
  auditLog: {},
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

vi.mock("@ai-ec/lambda-shared", () => ({
  getDb: () => getDbMock(),
  getQueueUrls: () => getQueueUrlsMock(),
  enqueue: (...args: unknown[]) => enqueueMock(...args),
  recordAuditLog: (...args: unknown[]) => recordAuditLogMock(...args),
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
  };
}

function makeEvent(method: string, path: string, query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString: "",
    queryStringParameters: query,
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

  it("returns 404 for an unknown route", async () => {
    fakeDb = createFakeDb([]);
    const res = await callHandler(makeEvent("GET", "/admin/nonexistent"));
    expect(res.statusCode).toBe(404);
  });
});
