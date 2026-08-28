import { beforeEach, describe, expect, it, vi } from "vitest";
import { EbayAdapter } from "./client.js";

const config = {
  clientId: "cid",
  clientSecret: "secret",
  ruName: "my-ru-name",
  merchantLocationKey: "loc-1",
  apiBaseUrl: "https://api.example-ebay.test",
  authBaseUrl: "https://auth.example-ebay.test",
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("EbayAdapter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the authorization URL against the RuName redirect", () => {
    const adapter = new EbayAdapter(config);
    const url = new URL(adapter.getAuthorizationUrl("state1", "unused"));
    expect(url.origin + url.pathname).toBe("https://auth.example-ebay.test/oauth2/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("my-ru-name");
  });

  it("creates an inventory item, offer, and publishes it", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({})) // PUT inventory_item
      .mockResolvedValueOnce(jsonResponse({ offerId: "offer-1" })) // POST offer
      .mockResolvedValueOnce(jsonResponse({})); // POST publish
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const result = await adapter.createListing("token", {
      productId: "p1",
      sku: "SKU-1",
      titleEn: "Vintage Jacket",
      descriptionHtmlEn: "<p>desc</p>",
      priceUsd: 49.99,
      quantity: 2,
      images: ["https://img.example/1.jpg"],
      categoryId: "12345",
      itemSpecifics: { Brand: "Unknown", Size: null },
    });

    expect(result.externalId).toBe("SKU-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example-ebay.test/sell/inventory/v1/inventory_item/SKU-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const offerCallBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(offerCallBody.pricingSummary.price.value).toBe("49.99");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.example-ebay.test/sell/inventory/v1/offer/offer-1/publish",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never asserts a null item specific as a real aspect value", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ offerId: "offer-1" }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.createListing("token", {
      productId: "p1",
      sku: "SKU-2",
      titleEn: "Bag",
      descriptionHtmlEn: "<p>desc</p>",
      priceUsd: 10,
      quantity: 1,
      images: [],
      categoryId: "1",
      itemSpecifics: { Brand: "Coach", Material: null },
    });

    const inventoryCallBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(inventoryCallBody.product.aspects).toEqual({ Brand: ["Coach"] });
    expect(inventoryCallBody.product.aspects.Material).toBeUndefined();
  });

  it("sets inventory quantity via PATCH", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.setInventory("token", "SKU-1", 0);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-ebay.test/sell/inventory/v1/inventory_item/SKU-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.availability.shipToLocationAvailability.quantity).toBe(0);
  });
});
