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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** AI-generated eBay content, kept separate so re-generation never clobbers the master. */
export const aiListingDraft = pgTable("ai_listing_draft", {
  id: uuid("id").primaryKey().defaultRandom(),
  productId: uuid("product_id")
    .notNull()
    .references(() => productMaster.id, { onDelete: "cascade" }),
  titleEn: text("title_en").notNull(),
  descriptionHtmlEn: text("description_html_en").notNull(),
  categoryCandidates: jsonb("category_candidates").notNull().$type<
    Array<{ ebayCategoryId: string; label: string }>
  >(),
  itemSpecifics: jsonb("item_specifics").notNull().$type<Record<string, string | null>>(),
  seoKeywords: jsonb("seo_keywords").notNull().$type<string[]>().default([]),
  suggestedPriceUsd: integer("suggested_price_usd_cents"),
  confidenceFlags: jsonb("confidence_flags").notNull().$type<Record<string, string>>(),
  needsHumanReview: boolean("needs_human_review").notNull().default(true),
  reviewNotes: jsonb("review_notes").notNull().$type<string[]>().default([]),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
