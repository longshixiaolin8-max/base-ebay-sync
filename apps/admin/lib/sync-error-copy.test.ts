import { describe, expect, it } from "vitest";
import { ERROR_CODE_LABEL } from "./sync-error-copy";

/**
 * Every errorCode this platform's workers actually pass to recordSyncError (grepped from
 * services/lambdas/*\/src/*.ts, excluding tests) -- kept as a literal list rather than
 * importing it, since the whole point is to catch a newly-introduced errorCode that forgot
 * to add matching copy here, which an import from the same source wouldn't be able to catch.
 */
const EMITTED_ERROR_CODES = [
  "ai_generate_failed",
  "ai_quota_exceeded",
  "channel_inventory_push_failed",
  "ebay_account_deletion_failed",
  "ebay_publish_failed",
  "ebay_update_failed",
  "ebay_seller_setup_required",
  "ebay_sync_quota_exceeded",
  "ebay_tracking_sync_failed",
  "inventory_diff_check_failed",
  "inventory_drift",
  "inventory_sync_failed",
  "offboarding_delist_failed",
  "order_record_failed",
  "possible_double_sale",
  "product_fetch_dispatch_failed",
  "product_fetch_failed",
  "product_quota_exceeded",
  "sales_poll_failed",
  "shipping_notice_email_failed",
];

describe("ERROR_CODE_LABEL", () => {
  it("has an entry for every errorCode the backend actually emits", () => {
    const missing = EMITTED_ERROR_CODES.filter((code) => !ERROR_CODE_LABEL[code]);
    expect(missing).toEqual([]);
  });

  it("gives every entry a non-empty title, summary, cause, and at least one step", () => {
    for (const [code, copy] of Object.entries(ERROR_CODE_LABEL)) {
      expect(copy.title, `${code}.title`).toBeTruthy();
      expect(copy.summary, `${code}.summary`).toBeTruthy();
      expect(copy.cause, `${code}.cause`).toBeTruthy();
      expect(copy.steps.length, `${code}.steps`).toBeGreaterThan(0);
    }
  });

  it("marks the eBay seller-setup-required error as a dead end for the retry button, not a false promise", () => {
    // sync_errors never carries a jobId for an ebay_publish/ebay_update failure (see
    // ebay-sync-worker's recordSyncError call), so the detail page's retry button
    // (gated on error.jobId) can never actually appear for this code -- retryable: true
    // here would describe a button the user will never see.
    expect(ERROR_CODE_LABEL.ebay_seller_setup_required?.retryable).toBe(false);
  });

  it("marks the eBay tracking-upload failure as retryable -- it's the one job type that does carry a jobId", () => {
    expect(ERROR_CODE_LABEL.ebay_tracking_sync_failed?.retryable).toBe(true);
  });
});
