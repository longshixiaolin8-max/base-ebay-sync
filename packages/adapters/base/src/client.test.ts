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
    expect(url.searchParams.get("scope")).toContain("write_items_stock");
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

  it("maps BASE items to ExternalProduct", async () => {
    const fetchMock = mockFetchOnce({
      items: [
        {
          item_id: "item-1",
          title: "T-Shirt",
          detail: "<p>desc</p>",
          price: 3000,
          stock: 5,
          images: [{ url: "https://img.example/1.jpg" }],
          updated: "2026-08-01T00:00:00Z",
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
      images: ["https://img.example/1.jpg"],
    });
    expect(result.nextCursor).toBeUndefined();
  });

  it("refuses createListing since BASE is always the source, not a sync target", async () => {
    const adapter = new BaseAdapter(config);
    await expect(adapter.createListing("token", {} as never)).rejects.toThrow(/not supported/);
  });

  it("throws BaseApiError on a non-2xx response", async () => {
    vi.stubGlobal("fetch", mockFetchOnce({ error: "unauthorized" }, 401));
    const adapter = new BaseAdapter(config);
    await expect(adapter.getInventory("token", "item-1")).rejects.toThrow(/BASE API error 401/);
  });
});
