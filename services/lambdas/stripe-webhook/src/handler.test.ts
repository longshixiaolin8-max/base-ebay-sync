import { beforeEach, describe, expect, it, vi } from "vitest";

const markTenantActiveMock = vi.fn().mockResolvedValue(undefined);
const markTenantInactiveMock = vi.fn().mockResolvedValue(undefined);
const findTenantByStripeCustomerIdMock = vi.fn();
vi.mock("@ai-ec/db", () => ({
  markTenantActive: (...args: unknown[]) => markTenantActiveMock(...args),
  markTenantInactive: (...args: unknown[]) => markTenantInactiveMock(...args),
  findTenantByStripeCustomerId: (...args: unknown[]) => findTenantByStripeCustomerIdMock(...args),
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

describe("POST /webhooks/stripe", () => {
  beforeEach(() => {
    markTenantActiveMock.mockClear();
    markTenantInactiveMock.mockClear();
    findTenantByStripeCustomerIdMock.mockReset();
    constructEventMock.mockReset();
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

  it("activates the tenant named in the checkout session's own metadata on checkout.session.completed", async () => {
    constructEventMock.mockReturnValue({
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId: "tenant-new" }, customer: "cus_1", subscription: "sub_1" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).toHaveBeenCalledWith(expect.anything(), "tenant-new", {
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("does nothing (but still returns 200) when checkout.session.completed is missing tenant metadata", async () => {
    constructEventMock.mockReturnValue({
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
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", id: "sub_1", status: "active" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantActiveMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", {
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
    });
  });

  it("marks the tenant past_due on customer.subscription.updated with a past_due status", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_1", id: "sub_1", status: "past_due" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantInactiveMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "past_due");
  });

  it("marks the tenant canceled on customer.subscription.deleted", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_1" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantInactiveMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "canceled");
  });

  it("marks the tenant past_due on invoice.payment_failed", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue({ id: "tenant-a" });
    constructEventMock.mockReturnValue({
      type: "invoice.payment_failed",
      data: { object: { customer: "cus_1" } },
    });

    await callHandler("{}", "sig_valid");

    expect(markTenantInactiveMock).toHaveBeenCalledWith(expect.anything(), "tenant-a", "past_due");
  });

  it("does nothing when no tenant matches the Stripe customer id", async () => {
    findTenantByStripeCustomerIdMock.mockResolvedValue(undefined);
    constructEventMock.mockReturnValue({
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_unknown" } },
    });

    const res = await callHandler("{}", "sig_valid");

    expect(markTenantInactiveMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it("ignores an event type it doesn't handle, returning 200", async () => {
    constructEventMock.mockReturnValue({ type: "customer.created", data: { object: {} } });

    const res = await callHandler("{}", "sig_valid");

    expect(res.statusCode).toBe(200);
    expect(markTenantActiveMock).not.toHaveBeenCalled();
    expect(markTenantInactiveMock).not.toHaveBeenCalled();
  });
});
