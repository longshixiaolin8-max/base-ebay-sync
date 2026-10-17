import { describe, expect, it } from "vitest";
import { assessCustomsRisk } from "./customs-risk.js";

describe("assessCustomsRisk", () => {
  it("reports no risk for an ordinary item with none of the flagged keywords", () => {
    const result = assessCustomsRisk({ title: "陶器の花瓶", descriptionJa: "手作りの陶器製花瓶です。", material: "陶器" });
    expect(result.hasRisk).toBe(false);
    expect(result.flags).toHaveLength(0);
  });

  it("flags a lithium battery mention in the Japanese title", () => {
    const result = assessCustomsRisk({ title: "モバイルバッテリー 10000mAh", descriptionJa: "" });
    expect(result.hasRisk).toBe(true);
    expect(result.flags[0]).toMatchObject({ category: "lithium_battery" });
  });

  it("flags a lithium battery mention only present in the English AI-generated description", () => {
    const result = assessCustomsRisk({ title: "充電器セット", descriptionEn: "Includes a rechargeable lithium battery pack." });
    expect(result.flags.some((f) => f.category === "lithium_battery")).toBe(true);
  });

  it("flags a CITES-restricted material from the material field alone", () => {
    const result = assessCustomsRisk({ title: "アンティークブローチ", material: "べっ甲" });
    expect(result.flags.some((f) => f.category === "cites_restricted_material")).toBe(true);
  });

  it("matches keywords case-insensitively for English terms", () => {
    const result = assessCustomsRisk({ title: "Vintage IVORY handle knife" });
    const categories = result.flags.map((f) => f.category);
    expect(categories).toContain("cites_restricted_material");
    expect(categories).toContain("weapon_or_replica");
  });

  it("reports at most one flag per category, even with multiple matching keywords", () => {
    const result = assessCustomsRisk({ title: "リチウム battery 充電式 rechargeable item" });
    const lithiumFlags = result.flags.filter((f) => f.category === "lithium_battery");
    expect(lithiumFlags).toHaveLength(1);
  });

  it("does not flag an unrelated word that merely contains a short English keyword as a substring", () => {
    const result = assessCustomsRisk({ title: "Cat Furniture Scratching Post Tower" });
    expect(result.flags.some((f) => f.category === "cites_restricted_material")).toBe(false);
  });

  it("can report multiple distinct categories for the same item", () => {
    const result = assessCustomsRisk({ title: "象牙の模造刀、バッテリー式ライト付き" });
    const categories = result.flags.map((f) => f.category).sort();
    expect(categories).toEqual(["cites_restricted_material", "lithium_battery", "weapon_or_replica"].sort());
  });
});
