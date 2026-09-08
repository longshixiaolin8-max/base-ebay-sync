import { describe, expect, it } from "vitest";
import { classifyStaleness } from "./stale.js";

describe("classifyStaleness", () => {
  it("is fresh at and below 30 days", () => {
    expect(classifyStaleness(0)).toBe("fresh");
    expect(classifyStaleness(30)).toBe("fresh");
  });

  it("crosses into stale_30 just past 30 days", () => {
    expect(classifyStaleness(31)).toBe("stale_30");
    expect(classifyStaleness(60)).toBe("stale_30");
  });

  it("crosses into stale_60 just past 60 days", () => {
    expect(classifyStaleness(61)).toBe("stale_60");
    expect(classifyStaleness(90)).toBe("stale_60");
  });

  it("crosses into stale_90 just past 90 days", () => {
    expect(classifyStaleness(91)).toBe("stale_90");
    expect(classifyStaleness(365)).toBe("stale_90");
  });
});
