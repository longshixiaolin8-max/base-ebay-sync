ALTER TABLE "tenants" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "timezone" text DEFAULT 'Asia/Tokyo';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "language" text DEFAULT 'ja';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_shipping_cost_jpy_domestic" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_shipping_cost_jpy_intl" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "default_target_margin_basis_points" integer;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "notification_preferences" jsonb;