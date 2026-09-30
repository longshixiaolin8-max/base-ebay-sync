import { beforeEach, describe, expect, it, vi } from "vitest";
import { AmazonAdapter } from "./client.js";

const config = { clientId: "cid", clientSecret: "secret", marketplaceId: "A1VC38T7YXB528", region: "fe" as const, sellerId: "SELLER1" };

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

function mockFetchSequence(bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  }
  return fn;
}

describe("AmazonAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the seller-authorization consent URL", () => {
    const adapter = new AmazonAdapter(config);
    const url = new URL(adapter.getAuthorizationUrl("state123", "https://app.example/callback"));
    expect(url.origin + url.pathname).toBe("https://sellercentral.amazon.com/apps/authorize/consent");
    expect(url.searchParams.get("application_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.example/callback");
  });

  it("exchanges the redirect's spapi_oauth_code for LWA tokens", async () => {
    const fetchMock = mockFetchOnce({ access_token: "at", refresh_token: "rt", token_type: "bearer", expires_in: 3600 });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    const tokens = await adapter.exchangeCodeForToken("spapi-oauth-code-value", "https://app.example/callback");

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(fetchMock).toHaveBeenCalledWith("https://api.amazon.com/auth/o2/token", expect.objectContaining({ method: "POST" }));
  });

  it("sends the LWA access token via the x-amz-access-token header, not Bearer", async () => {
    const fetchMock = mockFetchOnce({ sku: "sku-1", summaries: [{ marketplaceId: "A1VC38T7YXB528", itemName: "Item", productType: "LUGGAGE" }], attributes: {} });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    await adapter.getProduct("token-1", "sku-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/listings/2021-08-01/items/SELLER1/sku-1"),
      expect.objectContaining({ headers: expect.objectContaining({ "x-amz-access-token": "token-1" }) }),
    );
  });

  it("maps a listings item into ExternalProduct", async () => {
    const fetchMock = mockFetchOnce({
      sku: "sku-1",
      summaries: [{ marketplaceId: "A1VC38T7YXB528", itemName: "Vintage Jacket", productType: "APPAREL" }],
      attributes: {
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 3 }],
        list_price: [{ value: 5000 }],
        main_product_image_locator: [{ media_location: "https://cdn.example/1.jpg" }],
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    const product = await adapter.getProduct("token-1", "sku-1");

    expect(product).toMatchObject({
      externalId: "sku-1",
      title: "Vintage Jacket",
      priceJpy: 5000,
      quantity: 3,
      images: ["https://cdn.example/1.jpg"],
    });
  });

  it("updateListing sends a PATCH with replace ops for price and quantity", async () => {
    const fetchMock = mockFetchOnce({});
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    await adapter.updateListing("token-1", "sku-1", { priceUsd: 49.99, quantity: 10 });

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/listings/2021-08-01/items/SELLER1/sku-1"), expect.objectContaining({ method: "PATCH" }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.patches).toEqual([
      { op: "replace", path: "/attributes/list_price", value: [{ value: 49.99, currency: "USD" }] },
      { op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: 10 }] },
    ]);
  });

  it("setInventory delegates to updateListing with just the quantity patch", async () => {
    const fetchMock = mockFetchOnce({});
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    await adapter.setInventory("token-1", "sku-1", 7);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.patches).toEqual([{ op: "replace", path: "/attributes/fulfillment_availability", value: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] }]);
  });

  it("maps recent orders' items into SaleEvent, leaving price fields unset", async () => {
    const fetchMock = mockFetchSequence([
      { payload: { Orders: [{ AmazonOrderId: "111-222", PurchaseDate: "2024-03-02T00:00:00Z" }] } },
      { payload: { OrderItems: [{ ASIN: "B000", SellerSKU: "sku-1", QuantityOrdered: 2 }] } },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new AmazonAdapter(config);
    const sales = await adapter.listRecentSales("token-1", new Date("2024-03-01T00:00:00Z"));

    expect(sales).toEqual([
      { channel: "amazon", externalProductId: "sku-1", externalOrderId: "111-222", quantitySold: 2, occurredAt: new Date("2024-03-02T00:00:00Z") },
    ]);
  });

  it("listProducts and createListing both throw with an explanatory message rather than faking a response", async () => {
    const adapter = new AmazonAdapter(config);
    await expect(adapter.listProducts("token-1", {})).rejects.toThrow(/not implemented/);
    await expect(adapter.createListing("token-1", {} as never)).rejects.toThrow(/not implemented/);
  });
});
