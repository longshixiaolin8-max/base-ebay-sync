import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyAdapter } from "./client.js";

const config = { shopDomain: "my-store", clientId: "cid", clientSecret: "secret", defaultLocationId: "1" };

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

describe("ShopifyAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the authorization URL against this store's own subdomain, with the comma-separated scope list", () => {
    const adapter = new ShopifyAdapter(config);
    const url = new URL(adapter.getAuthorizationUrl("state123", "https://app.example/callback"));
    expect(url.origin + url.pathname).toBe("https://my-store.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toBe("read_products,write_products,read_orders,read_inventory,write_inventory");
  });

  it("exchanges an authorization code for an offline access token with no refresh token", async () => {
    const fetchMock = mockFetchOnce({ access_token: "shpat_abc", scope: "read_products" });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    const tokens = await adapter.exchangeCodeForToken("code123", "https://app.example/callback");

    expect(tokens.accessToken).toBe("shpat_abc");
    expect(tokens.refreshToken).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("https://my-store.myshopify.com/admin/oauth/access_token", expect.objectContaining({ method: "POST" }));
  });

  it("refreshToken always throws -- Shopify's offline tokens don't expire or refresh", async () => {
    const adapter = new ShopifyAdapter(config);
    await expect(adapter.refreshToken("whatever")).rejects.toThrow(/don't expire/);
  });

  it("sends requests with Shopify's own X-Shopify-Access-Token header, not a Bearer token", async () => {
    const fetchMock = mockFetchOnce({ products: [] });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    await adapter.listProducts("token-1", {});

    expect(fetchMock).toHaveBeenCalledWith(
      "https://my-store.myshopify.com/admin/api/2024-01/products.json?limit=250",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Shopify-Access-Token": "token-1" }) }),
    );
  });

  it("maps a Shopify product's first variant into ExternalProduct", async () => {
    const fetchMock = mockFetchOnce({
      products: [
        {
          id: 111,
          title: "Vintage Jacket",
          body_html: "<p>desc</p>",
          updated_at: "2024-03-01T00:00:00Z",
          images: [{ src: "https://cdn.example/1.jpg" }],
          variants: [{ id: 222, price: "49.99", inventory_item_id: 333, inventory_quantity: 5 }],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    const { items } = await adapter.listProducts("token-1", {});

    expect(items).toEqual([
      {
        externalId: "111",
        title: "Vintage Jacket",
        descriptionHtml: "<p>desc</p>",
        priceJpy: 49.99,
        quantity: 5,
        images: ["https://cdn.example/1.jpg"],
        updatedAt: new Date("2024-03-01T00:00:00Z"),
      },
    ]);
  });

  it("setInventory resolves the product's first variant's inventory_item_id, then sets it at the configured default location", async () => {
    const fetchMock = mockFetchSequence([
      { product: { id: 111, title: "x", body_html: "", updated_at: "2024-01-01T00:00:00Z", images: [], variants: [{ id: 222, price: "1", inventory_item_id: 333, inventory_quantity: 0 }] } },
      { inventory_level: {} },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    await adapter.setInventory("token-1", "111", 7);

    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://my-store.myshopify.com/admin/api/2024-01/inventory_levels/set.json", expect.objectContaining({ method: "POST" }));
    const secondCallBody = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(secondCallBody).toEqual({ location_id: 1, inventory_item_id: 333, available: 7 });
  });

  it("maps recent orders' line items into SaleEvent, leaving the price fields unset", async () => {
    const fetchMock = mockFetchOnce({
      orders: [
        {
          id: 999,
          created_at: "2024-03-02T00:00:00Z",
          line_items: [{ product_id: 111, quantity: 2, price: "49.99" }],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    const sales = await adapter.listRecentSales("token-1", new Date("2024-03-01T00:00:00Z"));

    expect(sales).toEqual([
      {
        channel: "shopify",
        externalProductId: "111",
        externalOrderId: "999",
        quantitySold: 2,
        occurredAt: new Date("2024-03-02T00:00:00Z"),
      },
    ]);
  });
});
