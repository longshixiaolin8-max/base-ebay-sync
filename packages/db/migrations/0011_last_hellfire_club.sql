CREATE TABLE IF NOT EXISTS "processed_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "grace_period_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "last_billing_event_at" timestamp with time zone;