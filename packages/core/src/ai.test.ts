import { describe, expect, it } from "vitest";
import { applyStandardAspectFallbacks, findMissingRequiredAspects } from "./ai.js";

describe("findMissingRequiredAspects", () => {
  it("returns nothing when every required aspect has a real value", () => {
    const itemSpecifics = { Brand: "Unbranded", Type: "Bracelet", Color: "Silver" };
    expect(findMissingRequiredAspects(itemSpecifics, ["Brand", "Type"])).toEqual([]);
  });

  it("flags a required aspect that is entirely absent from itemSpecifics", () => {
    const itemSpecifics = { Brand: "Unbranded" };
    expect(findMissingRequiredAspects(itemSpecifics, ["Brand", "Type"])).toEqual(["Type"]);
  });

  it("flags a required aspect that is present but null (the guardrail's honest 'unknown' marker)", () => {
    const itemSpecifics = { Brand: null, Type: "Bracelet" };
    expect(findMissingRequiredAspects(itemSpecifics, ["Brand", "Type"])).toEqual(["Brand"]);
  });

  it("flags a required aspect that is an empty string", () => {
    const itemSpecifics = { Brand: "", Type: "Bracelet" };
    expect(findMissingRequiredAspects(itemSpecifics, ["Brand", "Type"])).toEqual(["Brand"]);
  });

  it("returns an empty list when eBay requires nothing for this category", () => {
    expect(findMissingRequiredAspects({}, [])).toEqual([]);
  });
});

describe("applyStandardAspectFallbacks", () => {
  it("fills a required, still-null Brand with the standard 'Unbranded' placeholder", () => {
    const itemSpecifics = { Brand: null, Type: "Bracelet" };
    expect(applyStandardAspectFallbacks(itemSpecifics, ["Brand", "Type"])).toEqual({
      Brand: "Unbranded",
      Type: "Bracelet",
    });
  });

  it("never overrides a real, already-known Brand value", () => {
    const itemSpecifics = { Brand: "Coach", Type: "Bracelet" };
    expect(applyStandardAspectFallbacks(itemSpecifics, ["Brand", "Type"])).toEqual({
      Brand: "Coach",
      Type: "Bracelet",
    });
  });

  it("does not fill a required aspect with no standard placeholder (e.g. Type)", () => {
    const itemSpecifics = { Brand: "Unbranded", Type: null };
    expect(applyStandardAspectFallbacks(itemSpecifics, ["Brand", "Type"])).toEqual({
      Brand: "Unbranded",
      Type: null,
    });
  });

  it("does not add Brand when it is not actually required for this category", () => {
    const itemSpecifics = { Type: "Bracelet" };
    expect(applyStandardAspectFallbacks(itemSpecifics, ["Type"])).toEqual({ Type: "Bracelet" });
  });
});
