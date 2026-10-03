import type { ChannelAdapter } from "@ai-ec/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RakutenAdapter } from "./client.js";

const config = { serviceSecret: "svc-secret" };
const LICENSE_KEY = "tenant-license-key";

function mockFetchOnce(body: unknown, status = 200) {
  return vi.fn().mockResolvedValueOnce({
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

describe("RakutenAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("has no OAuth authorize-url flow -- getAuthorizationUrl/exchangeCodeForToken/refreshToken all throw explanatory errors", async () => {
    // Called through the ChannelAdapter interface, matching how real call sites (which only
    // ever hold a ChannelAdapter-typed reference) invoke it -- RakutenAdapter's own concrete
    // methods intentionally take fewer parameters (see client.ts's class doc).
    const adapter: ChannelAdapter = new RakutenAdapter(config);
    expect(() => adapter.getAuthorizationUrl("state", "https://app.example/callback")).toThrow(/no OAuth authorize-URL/);
    await expect(adapter.exchangeCodeForToken("code", "https://app.example/callback")).rejects.toThrow(/no authorization-code exchange/);
    await expect(adapter.refreshToken("whatever")).rejects.toThrow(/doesn't expire\/refresh/);
  });

  it("authenticates with the ESA scheme, base64(serviceSecret:licenseKey), not a Bearer token", async () => {
    const fetchMock = mockFetchOnce({ items: [] });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RakutenAdapter(config);
    await adapter.listProducts(LICENSE_KEY, {});

    const expectedAuth = `ESA ${Buffer.from(`svc-secret:${LICENSE_KEY}`).toString("base64")}`;
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/es/2.0/items/search"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: expectedAuth }) }));
  });

  it("maps a Rakuten item into ExternalProduct", async () => {
    const fetchMock = mockFetchOnce({
      itemUrl: "my-item-001",
      itemName: "Vintage Jacket",
      itemPrice: 8000,
      inventoryCount: 4,
      images: [{ imageUrl: "https://cdn.example/1.jpg" }],
      updateTimestamp: "2024-03-01T00:00:00Z",
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RakutenAdapter(config);
    const product = await adapter.getProduct(LICENSE_KEY, "my-item-001");

    expect(product).toEqual({
      externalId: "my-item-001",
      title: "Vintage Jacket",
      descriptionHtml: "",
      priceJpy: 8000,
      quantity: 4,
      images: ["https://cdn.example/1.jpg"],
      updatedAt: new Date("2024-03-01T00:00:00Z"),
    });
  });

  it("createListing throws -- Rakuten listings originate in RMS, not from this platform", async () => {
    const adapter = new RakutenAdapter(config);
    await expect(adapter.createListing(LICENSE_KEY, {} as never)).rejects.toThrow(/originate in RMS/);
  });

  it("setInventory posts the new quantity to the inventories/manage/update endpoint", async () => {
    const fetchMock = mockFetchOnce({});
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RakutenAdapter(config);
    await adapter.setInventory(LICENSE_KEY, "my-item-001", 6);

    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/es/1.0/inventories/manage/update"), expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ itemUrl: "my-item-001", inventoryCount: 6 });
  });

  it("maps recent orders' item details into SaleEvent with salePriceJpy set", async () => {
    const fetchMock = mockFetchOnce({
      orders: [
        {
          orderNumber: "123456-20240301",
          orderDatetime: "2024-03-02T00:00:00Z",
          packages: [{ itemDetails: [{ itemNumber: "my-item-001", itemName: "Vintage Jacket", units: 2, price: 8000 }] }],
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new RakutenAdapter(config);
    const sales = await adapter.listRecentSales(LICENSE_KEY, new Date("2024-03-01T00:00:00Z"));

    expect(sales).toEqual([
      {
        channel: "rakuten",
        externalProductId: "my-item-001",
        externalOrderId: "123456-20240301",
        quantitySold: 2,
        occurredAt: new Date("2024-03-02T00:00:00Z"),
        salePriceJpy: 16000,
      },
    ]);
  });
});
