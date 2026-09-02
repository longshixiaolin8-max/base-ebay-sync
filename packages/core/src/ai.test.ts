import { describe, expect, it } from "vitest";
import { findMissingRequiredAspects } from "./ai.js";

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
