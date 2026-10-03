import { describe, expect, it } from "vitest";
import { formatStripeAmount, stripeMinorToMajor } from "./format";

describe("Stripe amount formatting", () => {
  it("keeps JPY unit_amount as whole yen", () => {
    expect(stripeMinorToMajor(9800, "jpy")).toBe(9800);
    expect(formatStripeAmount(9800, "jpy")).toContain("9,800");
  });

  it("converts USD cents to major units", () => {
    expect(stripeMinorToMajor(9800, "usd")).toBe(98);
    expect(formatStripeAmount(9800, "usd")).toContain("98");
  });
});
