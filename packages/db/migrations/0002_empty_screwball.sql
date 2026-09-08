ALTER TABLE "ai_listing_draft" ADD COLUMN "condition" text;--> statement-breakpoint
-- Backfill pre-existing rows (from before this column existed, when eBay's ConditionEnum
-- was hardcoded to "NEW" everywhere) with a conservative used/vintage placeholder rather
-- than a guessed "NEW" -- a human should confirm the real value via the admin UI.
UPDATE "ai_listing_draft" SET "condition" = 'USED_VERY_GOOD' WHERE "condition" IS NULL;--> statement-breakpoint
ALTER TABLE "ai_listing_draft" ALTER COLUMN "condition" SET NOT NULL;
