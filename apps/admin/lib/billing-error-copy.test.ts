import { describe, expect, it } from "vitest";
import { ApiError } from "./api-client";
import { billingErrorMessage } from "./billing-error-copy";

describe("billingErrorMessage", () => {
  it("maps a known admin-api error code to Japanese guidance, never the raw response body", () => {
    const err = new ApiError(503, JSON.stringify({ error: "billing_not_live" }));
    const message = billingErrorMessage(err, "fallback");
    expect(message).not.toContain("billing_not_live");
    expect(message).not.toContain("{");
    expect(message).toBe("現在、本番決済がご利用いただけません。しばらくしてからもう一度お試しください。");
  });

  it("falls back to the caller's message for an error code it doesn't recognize", () => {
    const err = new ApiError(400, JSON.stringify({ error: "some_future_error_code" }));
    expect(billingErrorMessage(err, "fallback message")).toBe("fallback message");
  });

  it("falls back to the caller's message when the response body isn't JSON at all", () => {
    const err = new ApiError(502, "Bad Gateway");
    expect(billingErrorMessage(err, "fallback message")).toBe("fallback message");
  });

  it("falls back to the caller's message for a non-ApiError (e.g. a thrown plain Error)", () => {
    expect(billingErrorMessage(new Error("network down"), "fallback message")).toBe("fallback message");
  });
});
