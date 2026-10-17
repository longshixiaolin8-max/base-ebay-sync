ALTER TABLE "orders" ADD COLUMN "ship_to_country_code" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "ddp_confirmed_at" timestamp with time zone;