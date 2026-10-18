ALTER TABLE "orders" ADD COLUMN "ebay_line_item_id" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tracking_number" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "shipping_carrier_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ebay_tracking_synced_at" timestamp with time zone;