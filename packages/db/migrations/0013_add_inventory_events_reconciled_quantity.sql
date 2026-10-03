ALTER TABLE "inventory_events" ADD COLUMN IF NOT EXISTS "reconciled_quantity" integer;--> statement-breakpoint
ALTER TABLE "inventory_events" ADD COLUMN IF NOT EXISTS "ebay_sold_consumed" integer;