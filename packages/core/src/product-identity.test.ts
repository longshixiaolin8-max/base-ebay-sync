import { describe, expect, it } from "vitest";
import { matchProductIdentity } from "./product-identity.js";

describe("matchProductIdentity", () => {
  it("matches on a highly similar title alone", () => {
    // 8 of 9 unique tokens shared -> Jaccard 0.889 -> title score alone ≈ 53, over the
    // threshold with no other signal at all.
    const matches = matchProductIdentity(
      { title: "Vintage Sterling Silver Bead Bracelet Cross Charm Taxco" },
      [{ productId: "p1", title: "Vintage Sterling Silver Bead Bracelet Cross Charm Taxco Style" }],
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]!.productId).toBe("p1");
    expect(matches[0]!.reasons[0]).toMatch(/title similarity/);
  });

  it("does not match on a dissimilar title with no other signal", () => {
    const matches = matchProductIdentity({ title: "Men's Leather Wallet" }, [
      { productId: "p1", title: "Vintage Sterling Silver 925 Bead Bracelet" },
    ]);

    expect(matches).toEqual([]);
  });

  it("boosts a middling title similarity over the threshold with an exact brand+material+size match", () => {
    // Titles share 3 of 6 unique tokens (silver, bracelet, bead) -> Jaccard 0.5 -> title
    // score alone is 30, below the 50 threshold; +40 from three exact-attribute bonuses
    // pushes the total to 70.
    const withoutAttributes = matchProductIdentity({ title: "Silver Bracelet Bead Style" }, [
      { productId: "p1", title: "Sterling Silver Bracelet Bead Set" },
    ]);
    const withAttributes = matchProductIdentity(
      { title: "Silver Bracelet Bead Style", brand: "Tiffany", material: "Sterling Silver", sizeLabel: "M" },
      [{ productId: "p1", title: "Sterling Silver Bracelet Bead Set", brand: "Tiffany", material: "Sterling Silver", sizeLabel: "M" }],
    );

    expect(withoutAttributes).toEqual([]);
    expect(withAttributes).toHaveLength(1);
    expect(withAttributes[0]!.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/brand matches/), expect.stringMatching(/material matches/), expect.stringMatching(/size matches/)]),
    );
  });

  it("never credits a brand/material/size match when one side is missing it", () => {
    const matches = matchProductIdentity({ title: "Silver Bracelet", brand: "Tiffany" }, [
      { productId: "p1", title: "Silver Bracelet", brand: null },
    ]);

    // Title-only similarity here is high (identical), so it may still clear the threshold,
    // but the brand bonus specifically must not have been credited.
    if (matches.length > 0) {
      expect(matches[0]!.reasons.some((r) => r.includes("brand matches"))).toBe(false);
    }
  });

  it("ranks multiple candidates by score, highest first", () => {
    const matches = matchProductIdentity({ title: "Vintage Sterling Silver Bead Bracelet Cross Charm" }, [
      { productId: "weak", title: "Sterling Silver Ring" },
      { productId: "strong", title: "Vintage Sterling Silver Bead Bracelet Cross Charm Taxco" },
    ]);

    expect(matches[0]!.productId).toBe("strong");
  });

  it("returns nothing when there are no candidate products", () => {
    expect(matchProductIdentity({ title: "Anything" }, [])).toEqual([]);
  });
});
