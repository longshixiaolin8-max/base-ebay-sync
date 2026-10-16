import { describe, expect, it } from "vitest";
import { isSellerSetupRequiredMessage } from "./ebay-error-classification.js";

describe("isSellerSetupRequiredMessage", () => {
  it("matches an explicit SELLING_PRIVILEGE_REQUIRED error code", () => {
    expect(isSellerSetupRequiredMessage('{"errors":[{"errorId":25002,"message":"SELLING_PRIVILEGE_REQUIRED"}]}')).toBe(true);
  });

  it("matches a seller-account-registration message", () => {
    expect(isSellerSetupRequiredMessage("User does not have required selling privileges")).toBe(true);
    expect(isSellerSetupRequiredMessage("You need to create a seller's account")).toBe(true);
  });

  it("does not match an unrelated item-specifics validation failure sharing errorId 25002", () => {
    expect(isSellerSetupRequiredMessage('{"errors":[{"errorId":25002,"message":"Missing required item specifics: Type"}]}')).toBe(false);
  });

  it("does not match a transient outage message", () => {
    expect(isSellerSetupRequiredMessage('{"errors":[{"message":"Service unavailable"}]}')).toBe(false);
  });
});
