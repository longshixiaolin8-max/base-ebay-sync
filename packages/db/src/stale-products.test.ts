import { describe, expect, it } from "vitest";
import type { Database } from "./client.js";
import { findStaleProducts } from "./stale-products.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

/**
 * findStaleProducts issues two queries via Promise.all: product_master with no .where(), and
 * inventory_master with .where(). Promise.all adopts each array element in order, and this
 * mock's `then` resolves synchronously, so a shared call counter reliably matches responses
 * to queries by position regardless of which path (.from() directly vs .from().where()) a
 * given query takes.
 */
function fakeDb(products: { id: string; sku: string; title: string; createdAt: Date }[], soldOutIds: string[]): Database {
  let call = 0;
  const responses: unknown[][] = [
    products,
    products.filter((p) => !soldOutIds.includes(p.id)).map((p) => ({ productId: p.id, soldOut: false })),
  ];
  const thenable = () => ({ then: (resolve: (v: unknown) => void) => resolve(responses[call++]!) });

  return {
    select: () => ({
      from: () => ({
        ...thenable(),
        where: () => thenable(),
      }),
    }),
  } as unknown as Database;
}

describe("findStaleProducts", () => {
  it("excludes products under the threshold and sold-out products", async () => {
    const db = fakeDb(
      [
        { id: "fresh", sku: "s1", title: "Fresh", createdAt: daysAgo(5) },
        { id: "stale", sku: "s2", title: "Stale", createdAt: daysAgo(45) },
        { id: "sold-out-stale", sku: "s3", title: "Sold out but stale", createdAt: daysAgo(100) },
      ],
      ["sold-out-stale"],
    );

    const result = await findStaleProducts(db, 30);

    expect(result).toHaveLength(1);
    expect(result[0]!.productId).toBe("stale");
    expect(result[0]!.level).toBe("stale_30");
  });

  it("classifies staleness level and sorts oldest-first", async () => {
    const db = fakeDb(
      [
        { id: "p60", sku: "s1", title: "60d", createdAt: daysAgo(65) },
        { id: "p90", sku: "s2", title: "90d", createdAt: daysAgo(95) },
      ],
      [],
    );

    const result = await findStaleProducts(db, 30);

    expect(result[0]!.productId).toBe("p90");
    expect(result[0]!.level).toBe("stale_90");
    expect(result[1]!.productId).toBe("p60");
    expect(result[1]!.level).toBe("stale_60");
  });
});
