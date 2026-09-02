import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueMock = vi.fn().mockResolvedValue(undefined);
const listConnectedAccountIdsMock = vi.fn();
const getValidAccessTokenMock = vi.fn().mockResolvedValue("token");

vi.mock("./sqs.js", () => ({ enqueue: (...args: unknown[]) => enqueueMock(...args) }));
vi.mock("./secrets.js", () => ({
  listConnectedAccountIds: (...args: unknown[]) => listConnectedAccountIdsMock(...args),
  getValidAccessToken: (...args: unknown[]) => getValidAccessTokenMock(...args),
}));

const { pollChannelSales } = await import("./sales-sync.js");

describe("pollChannelSales", () => {
  beforeEach(() => {
    enqueueMock.mockClear();
    listConnectedAccountIdsMock.mockReset();
  });

  it("enqueues one sale_detected message per sale, deduped on channel+order+sku", async () => {
    listConnectedAccountIdsMock.mockResolvedValueOnce(["acct-1"]);
    const adapter = {
      channel: "ebay" as const,
      listRecentSales: vi.fn().mockResolvedValue([
        { channel: "ebay", externalProductId: "SKU-1", externalOrderId: "order-1", quantitySold: 1, occurredAt: new Date() },
      ]),
    };

    await pollChannelSales(adapter as never, new Date(0), {} as never, "queue-url");

    expect(enqueueMock).toHaveBeenCalledWith(
      "queue-url",
      { type: "sale_detected", sale: expect.objectContaining({ externalOrderId: "order-1" }) },
      "ebay:order-1:SKU-1",
    );
  });

  it("does nothing when the channel has no connected account", async () => {
    listConnectedAccountIdsMock.mockResolvedValueOnce([]);
    const adapter = { channel: "base" as const, listRecentSales: vi.fn() };

    await pollChannelSales(adapter as never, new Date(0), {} as never, "queue-url");

    expect(adapter.listRecentSales).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
