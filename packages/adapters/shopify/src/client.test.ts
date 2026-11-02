import { beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyAdapter } from "./client.js";

const config = { shopDomain: "my-store", clientId: "cid", clientSecret: "secret" };
/** The shared, no-shop-known singleton's own config, per loadImplementedChannelAdapters. */
const sharedConfig = { clientId: "cid", clientSecret: "secret" };

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
    expect(url.searchParams.get("scope")).toBe("read_products,write_products,read_orders,read_inventory,write_inventory,read_locations");
  });

  it("getAuthorizationUrl throws on the shared, shop-less singleton instance", () => {
    const adapter = new ShopifyAdapter(sharedConfig);
    expect(() => adapter.getAuthorizationUrl("state123", "https://app.example/callback")).toThrow(/no shop domain/);
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

  it("listProducts throws on the shared, shop-less singleton instance", async () => {
    const adapter = new ShopifyAdapter(sharedConfig);
    await expect(adapter.listProducts("token-1", {})).rejects.toThrow(/no shop domain/);
  });

  it("maps a Shopify product's first variant into ExternalProduct, with the shop domain composited into externalId", async () => {
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
        externalId: "my-store::111",
        title: "Vintage Jacket",
        descriptionHtml: "<p>desc</p>",
        priceJpy: 49.99,
        quantity: 5,
        images: ["https://cdn.example/1.jpg"],
        updatedAt: new Date("2024-03-01T00:00:00Z"),
      },
    ]);
  });

  it("createListing returns an externalId compositing this instance's own shop domain with the new product id", async () => {
    const fetchMock = mockFetchOnce({ product: { id: 111 } });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(config);
    const { externalId } = await adapter.createListing("token-1", {
      productId: "product-1",
      sku: "sku-1",
      titleEn: "Vintage Jacket",
      descriptionHtmlEn: "<p>desc</p>",
      priceUsd: 49.99,
      quantity: 5,
      images: [],
      categoryId: "",
      itemSpecifics: {},
      condition: "NEW",
    });

    expect(externalId).toBe("my-store::111");
  });

  it("createListing throws on the shared, shop-less singleton instance", async () => {
    const adapter = new ShopifyAdapter(sharedConfig);
    await expect(
      adapter.createListing("token-1", {
        productId: "product-1",
        sku: "sku-1",
        titleEn: "x",
        descriptionHtmlEn: "",
        priceUsd: 1,
        quantity: 1,
        images: [],
        categoryId: "",
        itemSpecifics: {},
        condition: "NEW",
      }),
    ).rejects.toThrow(/no shop domain/);
  });

  it("getProduct/updateListing/delistProduct parse the shop domain out of a composite externalId -- no config.shopDomain needed", async () => {
    const fetchMock = mockFetchOnce({
      product: { id: 111, title: "x", body_html: "", updated_at: "2024-01-01T00:00:00Z", images: [], variants: [] },
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(sharedConfig);
    const product = await adapter.getProduct("token-1", "my-store::111");

    expect(product?.externalId).toBe("my-store::111");
    expect(fetchMock).toHaveBeenCalledWith("https://my-store.myshopify.com/admin/api/2024-01/products/111.json", expect.anything());
  });

  it("updateListing sends a price change as its own PUT to the variant, not the product resource", async () => {
    const fetchMock = mockFetchSequence([
      { product: { id: 111, title: "x", body_html: "", updated_at: "2024-01-01T00:00:00Z", images: [], variants: [{ id: 222, price: "1", inventory_item_id: 333, inventory_quantity: 0 }] } },
      { variant: { id: 222, price: "59.99" } },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(sharedConfig);
    await adapter.updateListing("token-1", "my-store::111", { priceUsd: 59.99 });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://my-store.myshopify.com/admin/api/2024-01/variants/222.json", expect.objectContaining({ method: "PUT" }));
    const body = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(body).toEqual({ variant: { id: 222, price: "59.99" } });
  });

  it("getProduct throws a clear error on a bare, non-composite externalId", async () => {
    const adapter = new ShopifyAdapter(sharedConfig);
    await expect(adapter.getProduct("token-1", "111")).rejects.toThrow(/missing its.*shopDomain/);
  });

  it("setInventory resolves the product's first variant's inventory_item_id and this store's first location, on the shared shop-less instance", async () => {
    const fetchMock = mockFetchSequence([
      { product: { id: 111, title: "x", body_html: "", updated_at: "2024-01-01T00:00:00Z", images: [], variants: [{ id: 222, price: "1", inventory_item_id: 333, inventory_quantity: 0 }] } },
      { locations: [{ id: 1 }] },
      { inventory_level: {} },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new ShopifyAdapter(sharedConfig);
    await adapter.setInventory("token-1", "my-store::111", 7);

    expect(fetchMock).toHaveBeenNthCalledWith(3, "https://my-store.myshopify.com/admin/api/2024-01/inventory_levels/set.json", expect.objectContaining({ method: "POST" }));
    const thirdCallBody = JSON.parse((fetchMock.mock.calls[2]![1] as RequestInit).body as string);
    expect(thirdCallBody).toEqual({ location_id: 1, inventory_item_id: 333, available: 7 });
  });

  it("maps recent orders' line items into SaleEvent, compositing the shop domain into externalProductId, leaving the price fields unset", async () => {
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
        externalProductId: "my-store::111",
        externalOrderId: "999",
        quantitySold: 2,
        occurredAt: new Date("2024-03-02T00:00:00Z"),
      },
    ]);
  });
});
