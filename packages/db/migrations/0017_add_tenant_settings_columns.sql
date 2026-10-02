ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Tokyo';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "language" text DEFAULT 'ja';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "contact_email" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_shipping_cost_jpy_domestic" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_shipping_cost_jpy_intl" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "default_target_margin_basis_points" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "notification_preferences" jsonb;