import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * Product Master — the single source of truth. BASE and eBay listings are both derived
 * from this table; they are never synced with each other directly (see packages/core).
 */
export const productMaster = pgTable("product_master", {
  id: uuid("id").primaryKey().defaultRandom(),
  sku: text("sku").notNull().unique(),
  sourceChannel: text("source_channel").notNull(),
  title: text("title").notNull(),
  descriptionJa: text("description_ja").notNull().default(""),
  brand: text("brand"),
  material: text("material"),
  sizeLabel: text("size_label"),
  priceJpy: integer("price_jpy").notNull(),
  images: jsonb("images").notNull().$type<string[]>().default([]),
  status: text("status").notNull().default("draft"),
  contentHash: text("content_hash").notNull(),
  /**
   * Per-product pricing-calculator overrides (item #4 of the third hardening round,
   * "価格の動的整合") -- both null by default, meaning "use the platform-wide default".
   * Deliberately per-product rather than one global setting: a heavy item genuinely costs
   * more to ship than a small one, and a seller may want a slimmer margin on a slow mover.
   */
  shippingCostUsdCents: integer("shipping_cost_usd_cents"),
  /** Basis points, e.g. 3000 = 30.00%. */
  targetMarginBasisPoints: integer("target_margin_basis_points"),
  /**
   * 仕入価格 (item #3, "売上・利益管理"). Nullable -- a product synced from BASE before this
   * existed, or one whose cost simply hasn't been entered yet, has no cost data at all
   * rather than a misleading 0. `orders.cost_jpy` snapshots this at sale time so a later
   * edit here never retroactively changes an already-computed order's profit.
   */
  costJpy: integer("cost_jpy"),
  /** 仕入日 (item #4, "商品ライフサイクル管理" -- 仕入 stage). Nullable and independent of
   *  createdAt: a product can exist in product_master (synced from BASE) before its
   *  purchase/cost data has been entered by a human. */
  purchasedAt: timestamp("purchased_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** AI-generated eBay content, kept separate so re-generation never clobbers the master. */
export const aiListingDraft = pgTable("ai_listing_draft", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => productMaster.id, { onDelete: "cascade" }),
  /**
   * product_master.content_hash at the moment this draft was generated. If the product's
   * current content_hash no longer matches, BASE has changed title/description/price/images
   * since this draft was written -- the AI-generated title/description/condition/item
   * specifics may no longer describe the real product. The AI mis-listing gate (item #5)
   * checks this before every publish/update and blocks + regenerates rather than pushing a
   * possibly-stale listing to eBay.
   */
  sourceContentHash: text("source_content_hash").notNull(),
  titleEn: text("title_en").notNull(),
  descriptionHtmlEn: text("description_html_en").notNull(),
  categoryCandidates: jsonb("category_candidates").notNull().$type<
    Array<{ ebayCategoryId: string; label: string }>
  >(),
  itemSpecifics: jsonb("item_specifics").notNull().$type<Record<string, string | null>>(),
  seoKeywords: jsonb("seo_keywords").notNull().$type<string[]>().default([]),
  suggestedPriceUsd: integer("suggested_price_usd_cents"),
  /** eBay ConditionEnum value, derived from the source text -- never defaulted to "NEW". */
  condition: text("condition").notNull(),
  confidenceFlags: jsonb("confidence_flags").notNull().$type<Record<string, string>>(),
  needsHumanReview: boolean("needs_human_review").notNull().default(true),
  reviewNotes: jsonb("review_notes").notNull().$type<string[]>().default([]),
  /**
   * Item #7 ("AI運用改善"). Nullable -- a draft generated before this existed has no
   * recorded version. Lets a prompt/model change be correlated against actual sales
   * outcomes (joined through orders on product_id) instead of guessing from dates.
   */
  promptVersion: text("prompt_version"),
  /** What a human admin changed after generation (e.g. {"titleEn": "..."}), captured by the
   *  admin draft-edit endpoint -- the "人間修正値" this item asks to retain. Null until a
   *  human actually edits this specific draft. */
  humanCorrectedFields: jsonb("human_corrected_fields").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const channelListings = pgTable(
  "channel_listings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productMaster.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalId: text("external_id"),
    status: text("status").notNull().default("pending"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * The price this platform actually pushed to this channel the last time a sync
     * succeeded. Doubles as the anomaly-detection baseline ("does this new price look sane
     * next to what we last told the channel?") and, for eBay, the auto-rollback target.
     */
    lastSyncedPriceJpy: integer("last_synced_price_jpy"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    productChannelUnique: uniqueIndex("channel_listings_product_channel_unique").on(
      t.productId,
      t.channel,
    ),
  }),
);

/** Central inventory truth; `version` is the optimistic lock guarding against double-sell races. */
export const inventoryMaster = pgTable("inventory_master", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => productMaster.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(0),
  version: integer("version").notNull().default(0),
  soldOut: boolean("sold_out").notNull().default(false),
  /**
   * Units of true `quantity` withheld from every secondary (non-source) channel's
   * advertised availability, to shrink — not eliminate — the window where the same last
   * unit could be bought on two channels during sync lag. Never applied to the source
   * channel (BASE), which always reflects true stock; see calculateChannelAvailableQuantity.
   */
  safetyStockBuffer: integer("safety_stock_buffer").notNull().default(0),
  /**
   * BASE's own `modified` timestamp as of the last BASE stock-report we actually applied —
   * the logical clock watermark that lets applyBaseStockReport() reject a stale/out-of-order
   * report (one whose sequence isn't newer than this) instead of blindly trusting it.
   */
  lastBaseSeq: timestamp("last_base_seq", { withTimezone: true }),
  /**
   * Units sold on eBay (the secondary channel) since the last BASE stock report was
   * applied. BASE's own reported stock number reflects only BASE-side changes (BASE
   * itself never learns about an eBay sale unless/until we zero it out on total sellout),
   * so reconciling a new BASE report as `reported - ebaySoldSinceBaseSync` avoids
   * clobbering eBay sales BASE doesn't know about; reset to 0 each time a report applies.
   */
  ebaySoldSinceBaseSync: integer("ebay_sold_since_base_sync").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only ledger of every event that has ever changed (or attempted to change)
 * inventory_master.quantity. Two jobs: (1) the logical-clock ordering record -- a report
 * whose `sequenceAt` isn't newer than the channel's current watermark is logged here with
 * applied=false rather than silently dropped, so reversal/duplicate delivery is visible,
 * not just harmless; (2) the source of truth for reconstructInventory() to replay after
 * suspected drift or corruption, rather than trusting the mutable counter alone.
 */
export const inventoryEvents = pgTable("inventory_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => productMaster.id, { onDelete: "cascade" }),
  channel: text("channel").notNull(),
  eventType: text("event_type").notNull(), // "sale" | "base_stock_report"
  /** Logical clock value: BASE's `modified` ts for a stock report, the order's placed-at
   *  time for a sale. Compared against inventory_master.lastBaseSeq to detect reversal. */
  sequenceAt: timestamp("sequence_at", { withTimezone: true }).notNull(),
  /** Set for "sale" events: units sold in this event. */
  quantityDelta: integer("quantity_delta"),
  /** Set for "base_stock_report" events: BASE's reported absolute stock at sequenceAt. */
  absoluteQuantity: integer("absolute_quantity"),
  /** BASE order id / eBay order id, for correlating with the sale that produced this event. */
  externalEventId: text("external_event_id"),
  applied: boolean("applied").notNull().default(true),
  /** Why an event was recorded but not applied, e.g. "out_of_order". Null when applied. */
  skippedReason: text("skipped_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncJobs = pgTable("sync_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  type: text("type").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  productId: uuid("product_id"),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncErrors = pgTable("sync_errors", {
  id: uuid("id").primaryKey().defaultRandom(),
  jobId: uuid("job_id"),
  channel: text("channel"),
  productId: uuid("product_id"),
  errorCode: text("error_code").notNull(),
  errorMessage: text("error_message").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown> | null>(),
  resolved: boolean("resolved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * OAuth tokens are NEVER stored in plaintext here — only a pointer to the Secrets
 * Manager secret holding the actual access/refresh token, plus non-sensitive metadata
 * needed to decide when to refresh.
 */
export const oauthConnections = pgTable(
  "oauth_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channel: text("channel").notNull(),
    externalAccountId: text("external_account_id").notNull(),
    secretArn: text("secret_arn").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelAccountUnique: uniqueIndex("oauth_connections_channel_account_unique").on(
      t.channel,
      t.externalAccountId,
    ),
  }),
);

/** Backing store for packages/core's withIdempotency() guard. */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  status: text("status").notNull(),
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Item #1 of the commercial-features round ("正式なOrderモデルを追加"). One row per
 * (channel, external order id, product) -- the same granularity inventory-sync-worker
 * already processes sales at (see processSale/applySale) -- so this sits alongside the
 * existing inventory-truth machinery as a bookkeeping layer, never replacing it: applySale's
 * CAS-based double-sell prevention is untouched, this table only ever records what applySale
 * already decided. `status` is validated against @ai-ec/core's isValidOrderTransition before
 * every write (see @ai-ec/db's transitionOrderStatus).
 *
 * The financial fields are a per-order *snapshot* -- captured once each becomes known,
 * never recomputed from "current" product/channel state later -- so @ai-ec/core's
 * computeOrderProfit() reading them back is deterministic and idempotent: replaying it after
 * a return updates returnAmountUsdCents/status on this same row can only ever replace the
 * previously-reported profit figure, never add a second one on top of it.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => productMaster.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    externalOrderId: text("external_order_id").notNull(),
    quantity: integer("quantity").notNull(),
    status: text("status").notNull().default("ORDER_RECEIVED"),

    /** JPY unit cost, snapshotted from product_master.cost_jpy at sale time. */
    costJpy: integer("cost_jpy"),
    /** Set for a BASE sale (JPY-denominated). */
    salePriceJpy: integer("sale_price_jpy"),
    /** Set for an eBay sale (USD-denominated). */
    salePriceUsdCents: integer("sale_price_usd_cents"),
    ebayFeeUsdCents: integer("ebay_fee_usd_cents"),
    paymentFeeUsdCents: integer("payment_fee_usd_cents"),
    shippingCostJpy: integer("shipping_cost_jpy"),
    adSpendUsdCents: integer("ad_spend_usd_cents"),
    fxCostUsdCents: integer("fx_cost_usd_cents"),
    /** Amount refunded to the buyer, set once a return actually completes. */
    returnAmountUsdCents: integer("return_amount_usd_cents"),

    /** 利益確定 lifecycle stage: a human-triggered snapshot of computeOrderProfit()'s output
     *  at finalization time, so later reporting doesn't silently shift underneath a figure
     *  that's already been reported/reconciled elsewhere. Live (non-finalized) profit is
     *  always still computable on demand from the fields above. */
    finalizedNetProfitUsdCents: integer("finalized_net_profit_usd_cents"),
    profitFinalizedAt: timestamp("profit_finalized_at", { withTimezone: true }),

    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    allocatedAt: timestamp("allocated_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    returnRequestedAt: timestamp("return_requested_at", { withTimezone: true }),
    returnedAt: timestamp("returned_at", { withTimezone: true }),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    channelExternalOrderProductUnique: uniqueIndex("orders_channel_external_order_product_unique").on(
      t.channel,
      t.externalOrderId,
      t.productId,
    ),
  }),
);

/**
 * Item #6 ("SNS管理"). One row per product. Video creation and posting are recorded here as
 * human-confirmed flags (set via the admin API once someone actually posts), matching this
 * platform's existing pattern of AI producing a draft/suggestion and a human confirming the
 * real-world action (see ai_listing_draft.needsHumanReview) -- there is no video-generation
 * or social-posting API integration in this stack, so this table never claims one.
 */
export const snsContent = pgTable("sns_content", {
  productId: uuid("product_id")
    .primaryKey()
    .references(() => productMaster.id, { onDelete: "cascade" }),
  scriptText: text("script_text"),
  scriptPromptVersion: text("script_prompt_version"),
  videoCreated: boolean("video_created").notNull().default(false),
  videoCreatedAt: timestamp("video_created_at", { withTimezone: true }),
  instagramPosted: boolean("instagram_posted").notNull().default(false),
  instagramPostedAt: timestamp("instagram_posted_at", { withTimezone: true }),
  tiktokPosted: boolean("tiktok_posted").notNull().default(false),
  tiktokPostedAt: timestamp("tiktok_posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
