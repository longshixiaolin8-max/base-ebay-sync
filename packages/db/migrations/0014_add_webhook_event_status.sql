ALTER TABLE "processed_webhook_events" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'processing' NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_webhook_events" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "processed_webhook_events" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "processed_webhook_events" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Every row that existed before this migration was inserted under the old "insert = done"
-- design (see webhook-events.ts's own history) -- it was, in fact, fully processed, not
-- left mid-flight. Without this backfill every pre-existing row would default to
-- "processing" and look like a permanently stuck delivery the moment the new reclaim logic
-- (status = 'failed' OR stuck past a staleness threshold) starts evaluating it.
UPDATE "processed_webhook_events" SET "status" = 'completed', "updated_at" = "processed_at" WHERE "status" = 'processing';