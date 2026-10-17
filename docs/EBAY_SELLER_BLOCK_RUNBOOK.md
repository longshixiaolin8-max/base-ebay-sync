# eBay seller privilege block — production runbook

## Symptom and impact
If eBay rejects a publish/update with `SELLING_PRIVILEGE_REQUIRED`, the connected seller's ability to list is blocked outside this application. The platform cannot grant eBay seller privileges through an API call. Do **not** repeatedly republish or bulk-redrive the eBay DLQ while the block persists.

The worker now records `ebay_seller_setup_required`, preserves eBay's actionable message/URL in the listing and acknowledges only this specific class of SQS messages. Other API errors retain normal limited retries and DLQ behavior. eBay DLQ *scheduled* auto-redrive is disabled by default; manual retry remains possible after verifying account repair.

## Recover safely
1. Open the connected seller account's Seller Hub, review seller registration, identity verification, payout and billing setup, and restrictions. Complete any missing steps with eBay. This requires the account owner.
2. Confirm eBay actually permits a test listing in the same production seller account. Do not assume an OAuth success means seller privilege is enabled.
3. Inspect `channel_listings` and `sync_errors` for the affected tenant and SKU. Distinguish `ebay_seller_setup_required` from other `25002` causes such as missing category-specific item specifics.
4. Use the authenticated admin's per-item retry on the blocked listing after eBay accepts listings. Do **not** bulk-redrive a mixed DLQ unless every message has been triaged for staleness, stock, pricing, and cross-tenant impact.
5. Reconcile live quantity, price, and offer status on BASE/eBay to the central master before resuming unattended operation. In particular, ensure that a delayed retry cannot relist sold inventory.
6. Verify new successful sync, monitor `ebaySyncErrorAlarm` and `EbaySyncDlqDepthAlarm`, and close the incident only after alerts return to OK. Legacy DLQ messages remain until explicitly inspected/moved/removed under an approved retention procedure.

## Deployment and rollback
This change requires deploying the updated eBay sync worker and DLQ-redrive Lambda. An updated `infra/lib/lambda-stack.ts` sets `EBAY_SYNC_AUTO_REDRIVE_ENABLED=false`. **Merging a PR does not deploy it.** Do not deploy or merge without the production change approval and the checks required by the release workflow.

If transient eBay failures need a replay, use targeted manual retry. Re-enabling scheduled bulk eBay DLQ redrive requires an explicit reviewed code/config change. Avoid toggling Lambda environment variables directly outside CloudFormation because that creates stack drift.

## Operational caveats
This runbook addresses one confirmed endless-retry failure mode, not a guarantee that all merchant onboarding, billing, SES sending, inventory reconciliation, or tenant isolation paths are production-ready. Real account-level acceptance tests are still required.
