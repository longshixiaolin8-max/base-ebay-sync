ALTER TABLE "ai_listing_draft" ADD COLUMN "source_content_hash" text;--> statement-breakpoint
-- Backfill pre-existing draft rows (from before this column existed) with the product's
-- *current* content_hash. This is a deliberate assumption that pre-existing drafts are
-- still fresh as of migration time -- the AI mis-listing gate (item #5) will correctly
-- detect and flag any real drift starting from the next time the product's content
-- actually changes, which is exactly the case this column exists to catch.
UPDATE "ai_listing_draft" d
SET "source_content_hash" = p."content_hash"
FROM "product_master" p
WHERE d."product_id" = p."id" AND d."source_content_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "ai_listing_draft" ALTER COLUMN "source_content_hash" SET NOT NULL;
