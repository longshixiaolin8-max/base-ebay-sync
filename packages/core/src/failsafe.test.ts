import { describe, expect, it } from "vitest";
import { finalSafetyCheckForNewListing, finalSafetyCheckForUpdate } from "./failsafe.js";

const validNewListing = {
  titleEn: "Vintage Bracelet",
  descriptionHtmlEn: "<p>desc</p>",
  priceUsd: 49.99,
  quantity: 3,
  images: ["https://img.example/1.jpg"],
  categoryId: "12345",
  condition: "USED_GOOD",
};

describe("finalSafetyCheckForNewListing", () => {
  it("passes a fully valid payload", () => {
    expect(finalSafetyCheckForNewListing(validNewListing)).toEqual({ safe: true, violations: [] });
  });

  it("flags an empty title", () => {
    const result = finalSafetyCheckForNewListing({ ...validNewListing, titleEn: "  " });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain("title is empty");
  });

  it("flags a zero or negative price", () => {
    expect(finalSafetyCheckForNewListing({ ...validNewListing, priceUsd: 0 }).safe).toBe(false);
    expect(finalSafetyCheckForNewListing({ ...validNewListing, priceUsd: -5 }).safe).toBe(false);
  });

  it("flags a negative quantity but allows zero (a legitimate sellout)", () => {
    expect(finalSafetyCheckForNewListing({ ...validNewListing, quantity: -1 }).safe).toBe(false);
    expect(finalSafetyCheckForNewListing({ ...validNewListing, quantity: 0 }).safe).toBe(true);
  });

  it("flags no images", () => {
    expect(finalSafetyCheckForNewListing({ ...validNewListing, images: [] }).safe).toBe(false);
  });

  it("flags a missing category or condition", () => {
    expect(finalSafetyCheckForNewListing({ ...validNewListing, categoryId: "" }).safe).toBe(false);
    expect(finalSafetyCheckForNewListing({ ...validNewListing, condition: "" }).safe).toBe(false);
  });

  it("reports every violation at once, not just the first", () => {
    const result = finalSafetyCheckForNewListing({ ...validNewListing, titleEn: "", priceUsd: -1, images: [] });
    expect(result.violations).toHaveLength(3);
  });
});

describe("finalSafetyCheckForUpdate", () => {
  it("passes an empty payload — nothing being changed is never unsafe", () => {
    expect(finalSafetyCheckForUpdate({})).toEqual({ safe: true, violations: [] });
  });

  it("passes a partial payload with only some fields set, as long as those are valid", () => {
    expect(finalSafetyCheckForUpdate({ quantity: 5 })).toEqual({ safe: true, violations: [] });
  });

  it("flags a negative quantity when quantity is being changed", () => {
    const result = finalSafetyCheckForUpdate({ quantity: -1 });
    expect(result.safe).toBe(false);
    expect(result.violations).toContain("quantity is negative (-1)");
  });

  it("does not flag quantity when it isn't part of this update at all", () => {
    expect(finalSafetyCheckForUpdate({ titleEn: "New Title" }).safe).toBe(true);
  });

  it("flags a price of 0 or less when price is being changed", () => {
    expect(finalSafetyCheckForUpdate({ priceUsd: 0 }).safe).toBe(false);
  });

  it("flags an explicitly emptied images list", () => {
    expect(finalSafetyCheckForUpdate({ images: [] }).safe).toBe(false);
  });
});
