CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"external_order_id" text NOT NULL,
	"quantity" integer NOT NULL,
	"status" text DEFAULT 'ORDER_RECEIVED' NOT NULL,
	"cost_jpy" integer,
	"sale_price_jpy" integer,
	"sale_price_usd_cents" integer,
	"ebay_fee_usd_cents" integer,
	"payment_fee_usd_cents" integer,
	"shipping_cost_jpy" integer,
	"ad_spend_usd_cents" integer,
	"fx_cost_usd_cents" integer,
	"return_amount_usd_cents" integer,
	"finalized_net_profit_usd_cents" integer,
	"profit_finalized_at" timestamp with time zone,
	"placed_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"allocated_at" timestamp with time zone,
	"shipped_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"return_requested_at" timestamp with time zone,
	"returned_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sns_content" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"script_text" text,
	"script_prompt_version" text,
	"video_created" boolean DEFAULT false NOT NULL,
	"video_created_at" timestamp with time zone,
	"instagram_posted" boolean DEFAULT false NOT NULL,
	"instagram_posted_at" timestamp with time zone,
	"tiktok_posted" boolean DEFAULT false NOT NULL,
	"tiktok_posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_listing_draft" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "ai_listing_draft" ADD COLUMN "human_corrected_fields" jsonb;--> statement-breakpoint
ALTER TABLE "product_master" ADD COLUMN "cost_jpy" integer;--> statement-breakpoint
ALTER TABLE "product_master" ADD COLUMN "purchased_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_product_id_product_master_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_master"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sns_content" ADD CONSTRAINT "sns_content_product_id_product_master_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product_master"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_channel_external_order_product_unique" ON "orders" USING btree ("channel","external_order_id","product_id");