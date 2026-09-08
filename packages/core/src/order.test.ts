import { describe, expect, it } from "vitest";
import { isTerminalOrderStatus, isValidOrderTransition } from "./order.js";

describe("isValidOrderTransition", () => {
  it("allows the normal happy path", () => {
    expect(isValidOrderTransition("ORDER_RECEIVED", "PAID")).toBe(true);
    expect(isValidOrderTransition("PAID", "ALLOCATED")).toBe(true);
    expect(isValidOrderTransition("ALLOCATED", "SHIPPED")).toBe(true);
    expect(isValidOrderTransition("SHIPPED", "DELIVERED")).toBe(true);
  });

  it("allows a return starting from either SHIPPED or DELIVERED", () => {
    expect(isValidOrderTransition("SHIPPED", "RETURN_REQUESTED")).toBe(true);
    expect(isValidOrderTransition("DELIVERED", "RETURN_REQUESTED")).toBe(true);
    expect(isValidOrderTransition("RETURN_REQUESTED", "RETURNED")).toBe(true);
    expect(isValidOrderTransition("RETURNED", "REFUNDED")).toBe(true);
  });

  it("rejects an illegal jump", () => {
    expect(isValidOrderTransition("ORDER_RECEIVED", "SHIPPED")).toBe(false);
    expect(isValidOrderTransition("ORDER_RECEIVED", "DELIVERED")).toBe(false);
  });

  it("rejects resurrecting a terminal status", () => {
    expect(isValidOrderTransition("CANCELLED", "PAID")).toBe(false);
    expect(isValidOrderTransition("REFUNDED", "SHIPPED")).toBe(false);
  });

  it("allows cancellation from any pre-shipment status", () => {
    expect(isValidOrderTransition("ORDER_RECEIVED", "CANCELLED")).toBe(true);
    expect(isValidOrderTransition("PAID", "CANCELLED")).toBe(true);
    expect(isValidOrderTransition("ALLOCATED", "CANCELLED")).toBe(true);
  });
});

describe("isTerminalOrderStatus", () => {
  it("is true for CANCELLED and REFUNDED", () => {
    expect(isTerminalOrderStatus("CANCELLED")).toBe(true);
    expect(isTerminalOrderStatus("REFUNDED")).toBe(true);
  });

  it("is false for an in-flight status", () => {
    expect(isTerminalOrderStatus("SHIPPED")).toBe(false);
  });
});
