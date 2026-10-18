import { describe, expect, it } from "vitest";
import { EbayApiError, EbayPartialUpdateRolledBackError } from "@ai-ec/adapter-ebay";
import { isNonRetryableEbaySellerSetupError } from "./retry-policy.js";

describe("isNonRetryableEbaySellerSetupError", () => {
  it("holds explicit SELLING_PRIVILEGE_REQUIRED instead of recycling it through the DLQ", () => {
    const error = new EbayApiError(
      400,
      JSON.stringify({ errors: [{ errorId: 25002, message: "SELLING_PRIVILEGE_REQUIRED", longMessage: "You need to create a seller's account" }] }),
    );
    expect(isNonRetryableEbaySellerSetupError(error)).toBe(true);
  });

  it("detects an account block through a safely rolled-back partial update", () => {
    const cause = new EbayApiError(403, '{"errors":[{"message":"User does not have required selling privileges"}]}');
    expect(isNonRetryableEbaySellerSetupError(new EbayPartialUpdateRolledBackError(cause))).toBe(true);
  });

  it("does not classify missing item specifics merely because they share errorId 25002", () => {
    const error = new EbayApiError(400, '{"errors":[{"errorId":25002,"message":"Missing required item specifics: Type"}]}');
    expect(isNonRetryableEbaySellerSetupError(error)).toBe(false);
  });

  it("continues retrying transient eBay outages", () => {
    expect(isNonRetryableEbaySellerSetupError(new EbayApiError(503, '{"errors":[{"message":"Service unavailable"}]}'))).toBe(false);
  });

  it("does not trust unrelated exceptions containing the phrase", () => {
    expect(isNonRetryableEbaySellerSetupError(new Error("SELLING_PRIVILEGE_REQUIRED"))).toBe(false);
  });
});
