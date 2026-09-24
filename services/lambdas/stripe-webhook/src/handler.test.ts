import { beforeEach, describe, expect, it, vi } from "vitest";

const markTenantActiveMock = vi.fn().mockResolvedValue(true);
const markTenantPastDueMock = vi.fn().mockResolvedValue(true);
const markTenantCanceledWithGraceMock = vi.fn().mockResolvedValue({ applied: true, gracePeriodEndsAt: new Date("2026-02-01T00:00:00Z") });
const findTenantByStripeCustomerIdMock = vi.fn();
const claimWebhookEventMock = vi.fn().mockResolvedValue(true);
vi.mock("@ai-ec/db", () => ({
  markTenantActive: (...args: unknown[]) => markTenantActiveMock(...args),
  markTenantPastDue: (...args: unknown[]) => markTenantPastDueMock(...args),
  markTenantCanceledWithGrace: (...args: unknown[]) => markTenantCanceledWithGraceMock(...args),
  findTenantByStripeCustomerId: (...args: unknown[]) => findTenantByStripeCustomerIdMock(...args),
  claimWebhookEvent: (...args: unknown[]) => claimWebhookEventMock(...args),
}));

const getAppCredentialsMock = vi.fn().mockResolvedValue({
  secretKey: "sk_test",
  publishableKey: "pk_test",
  priceId: "price_1",
  webhookSigningSecret: "whsec_1",
});
const getDbMock = vi.fn(() => ({}));
const constructEventMock = vi.fn();
const createStripeClientMock = vi.fn(() => ({ webhooks: { constructEvent: constructEventMock } }));
vi.mock("@ai-ec/lambda-shared", () => ({
  getAppCredentials: () => getAppCredentialsMock(),
  getDb: () => getDbMock(),
  createStripeClient: () => createStripeClientMock(),
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
    claimWebhookEventMock.mockClear();
    claimWebhookEventMock.mockResolvedValue(true);
  });

  it("rejects a delivery with no Stripe-Signature header", async () => {
    const res = await callHandler("{}", undefined);
    expect(res.statusCode).toBe(400);
    expect(constructEventMock).not.toHaveBeenCalled();
  });

  it("rejects a delivery whose signature fails verification", async () => {
    constructEventMock.mockImplementation(() => {
      throw new Error("bad signature");
    });
    const res = await callHandler("{}", "sig_valid");
    expect(res.statusCode).toBe(400);
    expect(markTenantActiveMock).not.toHaveBeenCalled();
  });

  it("skips processing (but still returns 200) a redelivery of an already-claimed event", async () => {
    claimWebhookEventMock.mockResolvedValue(false);
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

  it("activates the tenant named in the checkout session's own metadata on checkout.session.completed", async () => {
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
    expect(res.statusCode).toBe(200);
  });

  it("does nothing (but still returns 200) when checkout.session.completed is missing tenant metadata", async () => {
    constructEventMock.mockReturnValue({
      id: "evt_1",
      created: EVENT_CREATED_UNIX,
      type: "checkout.session.completed",
      data: { object: { metadata: {}, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).not.toHaveBeenCalled();
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

  it("ignores an event type it doesn't handle, returning 200", async () => {
    constructEventMock.mockReturnValue({ id: "evt_1", created: EVENT_CREATED_UNIX, type: "customer.created", data: { object: {} } });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(200);
    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(markTenantPastDueMock).not.toHaveBeenCalled();
    expect(markTenantCanceledWithGraceMock).not.toHaveBeenCalled();
  });
});
