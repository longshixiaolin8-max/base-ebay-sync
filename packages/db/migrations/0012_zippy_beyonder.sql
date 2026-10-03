ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "ebay_fulfillment_policy_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "ebay_payment_policy_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "ebay_return_policy_id" text;