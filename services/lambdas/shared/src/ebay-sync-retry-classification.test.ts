import { describe, expect, it } from "vitest";
import type { Database } from "@ai-ec/db";
import { isEbayProductSyncRetryable } from "./ebay-sync-retry-classification.js";

function dbWithLatestError(row: { errorCode: string; errorMessage: string } | undefined): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => (row ? [row] : []),
          }),
        }),
      }),
    }),
  } as unknown as Database;
}

describe("isEbayProductSyncRetryable", () => {
  it("is retryable when there's no recorded sync_errors history for the product", async () => {
    await expect(isEbayProductSyncRetryable(dbWithLatestError(undefined), "tenant-a", "product-1")).resolves.toBe(true);
  });

  it("is retryable when no productId is given at all", async () => {
    await expect(isEbayProductSyncRetryable(dbWithLatestError(undefined), "tenant-a", undefined)).resolves.toBe(true);
  });

  it("is not retryable when the latest error is the dedicated seller-setup-required errorCode", async () => {
    const db = dbWithLatestError({ errorCode: "ebay_seller_setup_required", errorMessage: "SELLING_PRIVILEGE_REQUIRED" });
    await expect(isEbayProductSyncRetryable(db, "tenant-a", "product-1")).resolves.toBe(false);
  });

  it("is not retryable when a legacy, pre-classification errorCode's message still matches the seller-setup pattern", async () => {
    const db = dbWithLatestError({ errorCode: "ebay_update_failed", errorMessage: "User does not have required selling privileges" });
    await expect(isEbayProductSyncRetryable(db, "tenant-a", "product-1")).resolves.toBe(false);
  });

  it("is retryable for an ordinary transient failure", async () => {
    const db = dbWithLatestError({ errorCode: "ebay_update_failed", errorMessage: "Service unavailable" });
    await expect(isEbayProductSyncRetryable(db, "tenant-a", "product-1")).resolves.toBe(true);
  });
});
