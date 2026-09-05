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

function createdResponse(locationId: string) {
  return {
    ok: true,
    status: 201,
    json: async () => ({}),
    text: async () => "",
    headers: { get: (name: string) => (name === "Location" ? `https://api.example-ebay.test/x/${locationId}` : null) },
  };
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
      .mockResolvedValueOnce(jsonResponse({ offers: [] })) // GET offer?sku= (none exist yet)
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
      condition: "USED_GOOD",
    });

    expect(result.externalId).toBe("SKU-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.example-ebay.test/sell/inventory/v1/inventory_item/SKU-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const offerCallBody = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(offerCallBody.pricingSummary.price.value).toBe("49.99");
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.example-ebay.test/sell/inventory/v1/offer/offer-1/publish",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("reuses an existing offer instead of creating a duplicate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({})) // PUT inventory_item
      .mockResolvedValueOnce(jsonResponse({ offers: [{ offerId: "existing-offer", sku: "SKU-1" }] })) // GET offer?sku=
      .mockResolvedValueOnce(jsonResponse({})) // PUT offer/existing-offer
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
      images: [],
      categoryId: "12345",
      itemSpecifics: {},
      condition: "NEW",
    });

    expect(result.externalId).toBe("SKU-1");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.example-ebay.test/sell/inventory/v1/offer/existing-offer",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "https://api.example-ebay.test/sell/inventory/v1/offer/existing-offer/publish",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never asserts a null item specific as a real aspect value", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ offers: [] }))
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
      condition: "USED_GOOD",
    });

    const inventoryCallBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(inventoryCallBody.product.aspects).toEqual({ Brand: ["Coach"] });
    expect(inventoryCallBody.product.aspects.Material).toBeUndefined();
  });

  it("gets an application access token via client_credentials", async () => {
    const tokenMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "app-token", expires_in: 7200 }));
    vi.stubGlobal("fetch", tokenMock);

    const adapter = new EbayAdapter(config);
    const token = await adapter.getApplicationAccessToken();

    expect(token).toBe("app-token");
    const body = (tokenMock.mock.calls[0]?.[1] as RequestInit).body as URLSearchParams;
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("suggests real eBay categories for a query via the Taxonomy API", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        categorySuggestions: [
          { category: { categoryId: "10364", categoryName: "Bracelets" } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const suggestions = await adapter.suggestCategories("app-token", "silver bracelet");

    expect(suggestions).toEqual([{ ebayCategoryId: "10364", label: "Bracelets" }]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=silver"),
      expect.objectContaining({ headers: { Authorization: "Bearer app-token" } }),
    );
  });

  it("returns only the required aspects for a category, ignoring optional/recommended ones", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        aspects: [
          { localizedAspectName: "Brand", aspectConstraint: { aspectRequired: true } },
          { localizedAspectName: "Type", aspectConstraint: { aspectRequired: true } },
          { localizedAspectName: "Color", aspectConstraint: { aspectRequired: false } },
          { localizedAspectName: "Occasion" }, // aspectConstraint entirely absent — treat as not required
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const required = await adapter.getRequiredItemAspects("app-token", "262003");

    expect(required).toEqual(["Brand", "Type"]);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/commerce/taxonomy/v1/category_tree/0/get_item_aspects_for_category?category_id=262003"),
      expect.objectContaining({ headers: { Authorization: "Bearer app-token" } }),
    );
  });

  it("creates a notification destination and returns its id from the Location header", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createdResponse("dest-123"));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const result = await adapter.createNotificationDestination(
      "app-token",
      "AI EC Platform",
      "https://api.example.com/webhooks/ebay/notifications",
      "verify-me",
    );

    expect(result).toEqual({ destinationId: "dest-123" });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.deliveryConfig.verificationToken).toBe("verify-me");
  });

  it("creates a notification subscription and returns its id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createdResponse("sub-456"));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const result = await adapter.createNotificationSubscription("app-token", "LISTING", "dest-123");

    expect(result).toEqual({ subscriptionId: "sub-456" });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toMatchObject({ topicId: "LISTING", destinationId: "dest-123" });
  });

  it("updates the notification config with an alert email", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateNotificationConfig("app-token", "ops@example.com");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-ebay.test/commerce/notification/v1/config",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body).toEqual({ alertEmail: "ops@example.com" });
  });

  it("fetches the notification public key by id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ algorithm: "ECDSA", digest: "SHA1", key: "abc" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const key = await adapter.getNotificationPublicKey("app-token", "key-1");

    expect(key).toEqual({ algorithm: "ECDSA", digest: "SHA1", key: "abc" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-ebay.test/commerce/notification/v1/public_key/key-1",
      expect.objectContaining({ headers: { Authorization: "Bearer app-token" } }),
    );
  });

  it("creates a fulfillment policy and returns its id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ fulfillmentPolicyId: "fp-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const id = await adapter.createFulfillmentPolicy("token", "Standard Shipping");

    expect(id).toBe("fp-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-ebay.test/sell/account/v1/fulfillment_policy",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("creates a payment policy and returns its id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ paymentPolicyId: "pp-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const id = await adapter.createPaymentPolicy("token", "Standard Payment");

    expect(id).toBe("pp-1");
  });

  it("creates a return policy and returns its id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ returnPolicyId: "rp-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const id = await adapter.createReturnPolicy("token", "30 Day Returns");

    expect(id).toBe("rp-1");
  });

  it("includes listing policy ids on the offer when configured", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ offers: [] }))
      .mockResolvedValueOnce(jsonResponse({ offerId: "offer-1" }))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter({
      ...config,
      fulfillmentPolicyId: "fp-1",
      paymentPolicyId: "pp-1",
      returnPolicyId: "rp-1",
    });
    await adapter.createListing("token", {
      productId: "p1",
      sku: "SKU-3",
      titleEn: "Item",
      descriptionHtmlEn: "<p>d</p>",
      priceUsd: 20,
      quantity: 1,
      images: [],
      categoryId: "1",
      itemSpecifics: {},
      condition: "NEW",
    });

    const offerCallBody = JSON.parse((fetchMock.mock.calls[2]?.[1] as RequestInit).body as string);
    expect(offerCallBody.listingPolicies).toEqual({
      fulfillmentPolicyId: "fp-1",
      paymentPolicyId: "pp-1",
      returnPolicyId: "rp-1",
    });
  });

  it("creates an inventory location with the given address", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.createInventoryLocation("token", "osaka-main", {
      addressLine1: "Nagata 3-8-15-415",
      city: "Osaka-shi Joto-ku",
      stateOrProvince: "Osaka",
      postalCode: "536-0022",
      country: "JP",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example-ebay.test/sell/inventory/v1/location/osaka-main",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(body.location.address.postalCode).toBe("536-0022");
    expect(body.merchantLocationStatus).toBe("ENABLED");
  });

  it("updateListing pushes a quantity-only change even when no other field changed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sku: "SKU-1",
          product: { title: "Existing Title", description: "<p>existing</p>", imageUrls: [] },
          availability: { shipToLocationAvailability: { quantity: 9 } },
        }),
      ) // GET current (to merge unspecified fields)
      .mockResolvedValueOnce(jsonResponse({})); // PUT inventory_item
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateListing("token", "SKU-1", { quantity: 4 });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.example-ebay.test/sell/inventory/v1/inventory_item/SKU-1",
      expect.objectContaining({ method: "PUT" }),
    );
    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.availability.shipToLocationAvailability.quantity).toBe(4);
    expect(body.product.title).toBe("Existing Title"); // unspecified fields merged from current
  });

  it("updateListing sends an explicit condition instead of hardcoding NEW", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sku: "SKU-1",
          condition: "NEW",
          product: { title: "Existing Title", description: "<p>existing</p>", imageUrls: [] },
          availability: { shipToLocationAvailability: { quantity: 9 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateListing("token", "SKU-1", { condition: "USED_VERY_GOOD" });

    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.condition).toBe("USED_VERY_GOOD");
  });

  it("updateListing carries over the current condition when none is specified", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sku: "SKU-1",
          condition: "USED_GOOD",
          product: { title: "Existing Title", description: "<p>existing</p>", imageUrls: [] },
          availability: { shipToLocationAvailability: { quantity: 9 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateListing("token", "SKU-1", { quantity: 4 });

    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.condition).toBe("USED_GOOD");
  });

  it("updateListing carries over existing item-specific aspects when none are specified", async () => {
    // Regression: eBay's PUT inventory_item is a full replace, not a merge. A quantity-only
    // update that omitted `aspects` had silently wiped a category-required aspect (Type),
    // breaking the listing with errorId 25002 on the next republish -- confirmed live.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sku: "SKU-1",
          condition: "USED_EXCELLENT",
          product: {
            title: "Existing Title",
            description: "<p>existing</p>",
            imageUrls: [],
            aspects: { Type: ["Bracelet"], Brand: ["Unbranded"] },
          },
          availability: { shipToLocationAvailability: { quantity: 9 } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateListing("token", "SKU-1", { quantity: 4 });

    const body = JSON.parse((fetchMock.mock.calls[1]?.[1] as RequestInit).body as string);
    expect(body.product.aspects).toEqual({ Type: ["Bracelet"], Brand: ["Unbranded"] });
  });

  it("rolls back the content PUT and throws EbayPartialUpdateRolledBackError when the price PUT fails after content already succeeded", async () => {
    // Item #3 of the second hardening round ("自動ロールバック"). updateListing() makes two
    // independent calls -- if the content PUT lands but the price PUT then fails, the live
    // listing would otherwise show a new title/condition next to a stale price. Confirm the
    // content half gets reverted to exactly what it was, rather than left inconsistent.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          sku: "SKU-1",
          condition: "USED_GOOD",
          product: { title: "Existing Title", description: "<p>existing</p>", imageUrls: [], aspects: { Type: ["Bracelet"] } },
          availability: { shipToLocationAvailability: { quantity: 9 } },
        }),
      ) // GET current
      .mockResolvedValueOnce(jsonResponse({})) // PUT inventory_item (content, succeeds)
      .mockResolvedValueOnce(jsonResponse({ offers: [{ offerId: "offer-1", sku: "SKU-1" }] })) // GET offer?sku=
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "boom" }] }, 500)) // PUT offer (price, fails)
      .mockResolvedValueOnce(jsonResponse({})); // PUT inventory_item (rollback)
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);

    await expect(
      adapter.updateListing("token", "SKU-1", { titleEn: "New Title", priceUsd: 19.99 }),
    ).rejects.toThrow(/rolled back to its prior state/);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const rollbackCall = fetchMock.mock.calls[4] as [string, RequestInit];
    expect(rollbackCall[0]).toBe("https://api.example-ebay.test/sell/inventory/v1/inventory_item/SKU-1");
    expect(rollbackCall[1].method).toBe("PUT");
    const rollbackBody = JSON.parse(rollbackCall[1].body as string);
    // Reverted to the pre-update snapshot -- not the "New Title" the failed attempt tried to push.
    expect(rollbackBody.product.title).toBe("Existing Title");
    expect(rollbackBody.product.aspects).toEqual({ Type: ["Bracelet"] });
    expect(rollbackBody.condition).toBe("USED_GOOD");
  });

  it("does not roll back or wrap the error when only price changes and the price PUT fails", async () => {
    // No content PUT happened in this call at all, so there is nothing to roll back --
    // the original error should propagate unchanged.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ offers: [{ offerId: "offer-1", sku: "SKU-1" }] })) // GET offer?sku=
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "boom" }] }, 500)); // PUT offer (price, fails)
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);

    await expect(adapter.updateListing("token", "SKU-1", { priceUsd: 19.99 })).rejects.toMatchObject({
      name: "EbayApiError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2); // no third (rollback) call
  });

  it("updateListing makes no inventory_item call when nothing relevant changed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    await adapter.updateListing("token", "SKU-1", {});

    expect(fetchMock).not.toHaveBeenCalled();
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

  it("listRecentSales captures the line item's USD total as salePriceUsdCents", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        orders: [
          {
            orderId: "order-1",
            creationDate: "2026-08-01T00:00:00.000Z",
            lineItems: [{ sku: "SKU-1", quantity: 2, total: { value: "39.98", currency: "USD" } }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const sales = await adapter.listRecentSales("token", new Date("2026-08-01T00:00:00Z"));

    expect(sales).toEqual([
      {
        channel: "ebay",
        externalProductId: "SKU-1",
        externalOrderId: "order-1",
        quantitySold: 2,
        occurredAt: new Date("2026-08-01T00:00:00.000Z"),
        salePriceUsdCents: 3998,
      },
    ]);
  });

  it("listRecentSales leaves salePriceUsdCents undefined for a non-USD line item, rather than misreporting it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        orders: [
          {
            orderId: "order-1",
            creationDate: "2026-08-01T00:00:00.000Z",
            lineItems: [{ sku: "SKU-1", quantity: 1, total: { value: "50.00", currency: "GBP" } }],
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const sales = await adapter.listRecentSales("token", new Date());

    expect(sales[0]?.salePriceUsdCents).toBeUndefined();
  });

  it("listRecentSales leaves salePriceUsdCents undefined when the line item has no total at all", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        orders: [{ orderId: "order-1", creationDate: "2026-08-01T00:00:00.000Z", lineItems: [{ sku: "SKU-1", quantity: 1 }] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new EbayAdapter(config);
    const sales = await adapter.listRecentSales("token", new Date());

    expect(sales[0]?.salePriceUsdCents).toBeUndefined();
  });
});
