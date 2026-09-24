CREATE TABLE IF NOT EXISTS "inventory_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"event_type" text NOT NULL,
	"sequence_at" timestamp with time zone NOT NULL,
	"quantity_delta" integer,
	"absolute_quantity" integer,
	"external_event_id" text,
	"applied" boolean DEFAULT true NOT NULL,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_master" ADD COLUMN "last_base_seq" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "inventory_master" ADD COLUMN "ebay_sold_since_base_sync" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "inventory_events" ADD CONSTRAINT "inventory_events_product_id_product_master_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_master"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
