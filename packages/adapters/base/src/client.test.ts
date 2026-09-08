import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseAdapter } from "./client.js";

const config = { clientId: "cid", clientSecret: "secret", apiBaseUrl: "https://api.example-base.test" };

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** For calls that make more than one sequential fetch (e.g. listRecentSales' list-then-detail
 *  calls) -- each body is returned to the next fetch() call in order. */
function mockFetchSequence(bodies: unknown[]) {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
  }
  return fn;
}

describe("BaseAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the authorization URL with required scopes", () => {
    const adapter = new BaseAdapter(config);
    const url = new URL(adapter.getAuthorizationUrl("state123", "https://app.example/callback"));
    expect(url.origin + url.pathname).toBe("https://api.example-base.test/1/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toBe("read_items write_items read_orders");
  });

  it("exchanges an authorization code for tokens", async () => {
    const fetchMock = mockFetchOnce({
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      scope: "read_items",
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const tokens = await adapter.exchangeCodeForToken("code123", "https://app.example/callback");

    expect(tokens.accessToken).toBe("at");
    expect(tokens.refreshToken).toBe("rt");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-base.test/1/oauth/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps BASE items to ExternalProduct, reading photos from imgN_origin fields", async () => {
    // Shape verified against a live BASE item: no "images" array, no "updated" field —
    // photos are flat img1_origin.. fields and the timestamp is "modified" (Unix seconds).
    const fetchMock = mockFetchOnce({
      items: [
        {
          item_id: "item-1",
          title: "T-Shirt",
          detail: "<p>desc</p>",
          price: 3000,
          stock: 5,
          modified: 1788157953,
          img1_origin: "https://img.example/1.jpg",
          img2_origin: "https://img.example/2.jpg",
          img3_origin: null,
        },
      ],
      offset: 0,
      limit: 100,
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const result = await adapter.listProducts("token", {});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      externalId: "item-1",
      title: "T-Shirt",
      priceJpy: 3000,
      quantity: 5,
      images: ["https://img.example/1.jpg", "https://img.example/2.jpg"],
    });
    expect(result.items[0]?.updatedAt).toEqual(new Date(1788157953 * 1000));
    expect(result.nextCursor).toBeUndefined();
  });

  it("maps BASE items with no img*_origin fields to an empty images array", async () => {
    const fetchMock = mockFetchOnce({
      items: [
        {
          item_id: "item-2",
          title: "No Photo Yet",
          detail: "<p>desc</p>",
          price: 1500,
          stock: 1,
          modified: 1788157953,
        },
      ],
      offset: 0,
      limit: 100,
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const result = await adapter.listProducts("token", {});

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.images).toEqual([]);
  });

  it("getProduct fetches the detail endpoint with item_id as a path segment, not a query param", async () => {
    // BASE's own reference (docs.thebase.in/docs/api/items/detail): GET /1/items/detail/:item_id.
    // items/detail also carries the full up-to-20 image slots, unlike items/search which is
    // capped at 5 -- verified live via a real product that has 6 photos on BASE but only 5
    // came through listProducts.
    const fetchMock = mockFetchOnce({
      item: {
        item_id: "item-6photos",
        title: "Bracelet",
        detail: "<p>desc</p>",
        price: 5000,
        stock: 1,
        modified: 1788157953,
        img1_origin: "https://img.example/1.jpg",
        img2_origin: "https://img.example/2.jpg",
        img3_origin: "https://img.example/3.jpg",
        img4_origin: "https://img.example/4.jpg",
        img5_origin: "https://img.example/5.jpg",
        img6_origin: "https://img.example/6.jpg",
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const result = await adapter.getProduct("token", "item-6photos");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-base.test/1/items/detail/item-6photos",
      expect.anything(),
    );
    expect(result?.images).toHaveLength(6);
    expect(result?.images[5]).toBe("https://img.example/6.jpg");
  });

  it("refuses createListing since BASE is always the source, not a sync target", async () => {
    const adapter = new BaseAdapter(config);
    await expect(adapter.createListing("token", {} as never)).rejects.toThrow(/not supported/);
  });

  it("listRecentSales fetches order_items from the detail endpoint, since the list endpoint has none", async () => {
    // Verified against BASE's own gist-hosted reference (gist.github.com/baseinc/9760824,
    // 9930892): GET /1/orders has no order_items at all; unique_key/ordered (Unix seconds)
    // are the only fields that matter here. order_items with real pricing only exist on
    // GET /1/orders/detail/:unique_key.
    const since = new Date("2026-08-01T00:00:00Z");
    const fetchMock = mockFetchSequence([
      { orders: [{ unique_key: "order-1", ordered: Math.floor(since.getTime() / 1000) + 3600 }] },
      {
        order: {
          unique_key: "order-1",
          ordered: Math.floor(since.getTime() / 1000) + 3600,
          order_items: [
            { item_id: 1000, amount: 2, total: 4000 },
            { item_id: 1001, amount: 1, total: 3000 },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const sales = await adapter.listRecentSales("token", since);

    expect(sales).toHaveLength(2);
    expect(sales[0]).toMatchObject({
      channel: "base",
      externalProductId: "1000",
      externalOrderId: "order-1",
      quantitySold: 2,
      salePriceJpy: 4000,
    });
    expect(sales[1]).toMatchObject({ externalProductId: "1001", quantitySold: 1, salePriceJpy: 3000 });
    // Second fetch call must hit the detail endpoint with unique_key as a path segment.
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://api.example-base.test/1/orders/detail/order-1", expect.anything());
  });

  it("listRecentSales filters out orders older than `since` client-side, regardless of the server-side prefilter", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const tooOld = Math.floor(since.getTime() / 1000) - 3600;
    const fetchMock = mockFetchSequence([{ orders: [{ unique_key: "stale-order", ordered: tooOld }] }]);
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new BaseAdapter(config);
    const sales = await adapter.listRecentSales("token", since);

    expect(sales).toEqual([]);
    // Only the list call should have happened -- no detail call for a filtered-out order.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("listRecentSales returns an empty array when there are no recent orders", async () => {
    vi.stubGlobal("fetch", mockFetchSequence([{ orders: [] }]));
    const adapter = new BaseAdapter(config);
    const sales = await adapter.listRecentSales("token", new Date());
    expect(sales).toEqual([]);
  });

  it("throws BaseApiError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: "unauthorized" }, 401));
    const adapter = new BaseAdapter(config);
    await expect(adapter.getInventory("token", "item-1")).rejects.toThrow(/BASE API error 401/);
  });
});
