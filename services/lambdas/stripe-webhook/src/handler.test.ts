import { beforeEach, describe, expect, it, vi } from "vitest";

const markTenantActiveMock = vi.fn().mockResolvedValue(true);
const markTenantPastDueMock = vi.fn().mockResolvedValue(true);
const markTenantCanceledWithGraceMock = vi.fn().mockResolvedValue({ applied: true, gracePeriodEndsAt: new Date("2026-02-01T00:00:00Z") });
const findTenantByStripeCustomerIdMock = vi.fn();
const claimWebhookEventMock = vi.fn();
const completeWebhookEventMock = vi.fn().mockResolvedValue(undefined);
const failWebhookEventMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@ai-ec/db", () => ({
  markTenantActive: (...args: unknown[]) => markTenantActiveMock(...args),
  markTenantPastDue: (...args: unknown[]) => markTenantPastDueMock(...args),
  markTenantCanceledWithGrace: (...args: unknown[]) => markTenantCanceledWithGraceMock(...args),
  findTenantByStripeCustomerId: (...args: unknown[]) => findTenantByStripeCustomerIdMock(...args),
  claimWebhookEvent: (...args: unknown[]) => claimWebhookEventMock(...args),
  completeWebhookEvent: (...args: unknown[]) => completeWebhookEventMock(...args),
  failWebhookEvent: (...args: unknown[]) => failWebhookEventMock(...args),
}));

const getAppCredentialsMock = vi.fn().mockResolvedValue({
  secretKey: "sk_test",
  publishableKey: "pk_test",
  priceId: "price_1",
  webhookSigningSecret: "whsec_1",
});
/** transaction(fn) just calls fn with this same fake db -- these tests only care about call
 *  sequencing/arguments, not real Postgres atomicity, matching this codebase's other
 *  db.transaction()-using handler tests (e.g. inventory-sync-worker's). */
const fakeDb = { transaction: async (fn: (tx: unknown) => unknown) => fn(fakeDb) };
const getDbMock = vi.fn(() => fakeDb);
const constructEventMock = vi.fn();
const createStripeClientMock = vi.fn(() => ({ webhooks: { constructEvent: constructEventMock } }));
vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: () => getAppCredentialsMock(),
  getDb: () => getDbMock(),
  createStripeClient: () => createStripeClientMock(),
  requireCloudFrontOrigin: () => null,
}));

const { handler } = await import("./handler.js");

function makeEvent(body: string, signature: string | undefined) {
  return {
    body,
    isBase64Encoded: false,
    headers: signature ? { "stripe-signature": signature } : {},
  } as never;
}

async function callHandler(body: string, signature: string | undefined) {
  return (await handler(makeEvent(body, signature))) as { statusCode: number; body?: string };
}

const EVENT_CREATED_UNIX = 1780000000; // arbitrary fixed unix-seconds timestamp used across events below
const EVENT_CREATED_DATE = new Date(EVENT_CREATED_UNIX * 1000);

describe("POST /webhooks/stripe", () => {
  beforeEach(() => {
    markTenantActiveMock.mockClear();
    markTenantPastDueMock.mockClear();
    markTenantCanceledWithGraceMock.mockClear();
    findTenantByStripeCustomerIdMock.mockReset();
    constructEventMock.mockReset();
    claimWebhookEventMock.mockReset();
    claimWebhookEventMock.mockResolvedValue({ claimed: true });
    completeWebhookEventMock.mockClear();
    failWebhookEventMock.mockClear();
  });

  it("rejects a delivery with no Stripe-Signature header", async () => {
    const res = await callHandler("{}", undefined);
    expect(res.statusCode).toBe(400);
    expect(constructEventMock).not.toHaveBeenCalled();
    expect(claimWebhookEventMock).not.toHaveBeenCalled();
  });

  it("rejects a delivery whose signature fails verification, without ever claiming it", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await callHandler("{}", "sig_valid");
    expect(res.statusCode).toBe(400);
    expect(claimWebhookEventMock).not.toHaveBeenCalled();
    expect(markTenantActiveMock).not.toHaveBeenCalled();
  });

  it("skips processing (but still returns 200) a redelivery of an already-completed event -- a true duplicate", async () => {
    claimWebhookEventMock.mockResolvedValue({ claimed: false, status: "completed" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(claimWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({ received: true, duplicate: true });
  });

  it("returns a non-2xx (not a false duplicate ack) when another invocation's claim is still within its staleness window", async () => {
    claimWebhookEventMock.mockResolvedValue({ claimed: false, status: "processing" });
    constructEventMock.mockReturnValue({ id: "evt_1", created: EVENT_CREATED_UNIX, type: "checkout.session.completed", data: { object: {} } });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(409);
    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(completeWebhookEventMock).not.toHaveBeenCalled();
  });

  it("activates the tenant named in the checkout session's own metadata, then marks the event completed", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-new",
      { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
      EVENT_CREATED_DATE,
    );
    expect(completeWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
    expect(failWebhookEventMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("does nothing (but still marks completed and returns 200) when checkout.session.completed is missing tenant metadata", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: {}, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(completeWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
    expect(res.statusCode).toBe(200);
  });

  it("reactivates the tenant on customer.subscription.updated with an active status", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", id: "sub_1", status: "active" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).toHaveBeenCalledWith(
      expect.anything(),
      "tenant-a",
      { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" },
      EVENT_CREATED_DATE,
    );
  });

  it("marks the tenant past_due on customer.subscription.updated with a past_due status", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", id: "sub_1", status: "past_due" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantPastDueMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", EVENT_CREATED_DATE);
  });

  it("marks the tenant canceled_grace on customer.subscription.updated with a canceled status", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", id: "sub_1", status: "canceled" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantCanceledWithGraceMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", EVENT_CREATED_DATE);
  });

  it("marks the tenant canceled_grace on customer.subscription.deleted", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_1" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantCanceledWithGraceMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", EVENT_CREATED_DATE);
  });

  it("marks the tenant past_due on invoice.payment_failed", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantPastDueMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", EVENT_CREATED_DATE);
  });

  it("does nothing when no tenant matches the Stripe customer id", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue(undefined);
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_unknown" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantCanceledWithGraceMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("ignores an event type it doesn't handle, still marking it completed and returning 200", async () => {
    constructEventMock.mockReturnValue({ id: "evt_1", created: EVENT_CREATED_UNIX, type: "customer.created", data: { object: {} } });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(200);
    expect(completeWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(markTenantPastDueMock).not.toHaveBeenCalled();
    expect(markTenantCanceledWithGraceMock).not.toHaveBeenCalled();
  });

  it("marks the event failed and returns a non-2xx (for Stripe to retry) when the billing mutation itself throws", async () => {
    // This is the exact bug this round fixes: previously, a claim succeeding followed by a
    // mutation failure left the row permanently claimed, and Stripe's retry of the same
    // event would be met with an immediate false "duplicate" ack that never actually
    // applied the tenant status change.
    markTenantActiveMock.mockRejectedValueOnce(new Error("connection reset"));
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(500);
    expect(failWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1", "connection reset");
    expect(completeWebhookEventMock).not.toHaveBeenCalled();
  });

  it("reprocesses successfully on a later retry after claimWebhookEvent reclaims a failed/expired delivery", async () => {
    // Simulates the retry that follows the previous test: this time claimWebhookEvent
    // reports a fresh claim (its own reclaim logic, exercised separately in
    // webhook-events.test.ts, already having decided this is retryable), and the mutation
    // succeeds this time.
    claimWebhookEventMock.mockResolvedValue({ claimed: true });
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(200);
    expect(markTenantActiveMock).toHaveBeenCalledTimes(1);
    expect(completeWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
  });

  it("still honors the out-of-order guard: an update that markTenantActive itself declines to apply is not treated as a failure", async () => {
    // markTenant* returning false (its own isStale guard) is a normal, successful outcome --
    // the event was still fully "processed" (a deliberate no-op), not a mutation failure.
    markTenantActiveMock.mockResolvedValueOnce(false);
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(200);
    expect(completeWebhookEventMock).toHaveBeenCalledWith(expect.anything(), "stripe", "evt_1");
    expect(failWebhookEventMock).not.toHaveBeenCalled();
  });
});
