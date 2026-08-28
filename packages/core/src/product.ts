import { z } from "zod";
import { ChannelType } from "./channel.js";

/**
 * The AWS-side "Product Master" — the single source of truth. BASE and eBay (and any
 * future channel) are always synced through this record, never directly with each other.
 */
export const ProductStatus = z.enum(["draft", "ai_generated", "active", "sold_out", "archived"]);
export type ProductStatus = z.infer<typeof ProductStatus>;

export const ProductMaster = z.object({
  id: z.string().uuid(),
  /** Canonical internal SKU. Generated once, never reused, immutable. */
  sku: z.string().min(1),
  sourceChannel: ChannelType,
  title: z.string().min(1),
  descriptionJa: z.string().default(""),
  brand: z.string().nullable().default(null),
  material: z.string().nullable().default(null),
  sizeLabel: z.string().nullable().default(null),
  priceJpy: z.number().int().nonnegative(),
  images: z.array(z.string().url()).default([]),
  status: ProductStatus,
  /** Hash of the fields that matter for downstream sync, used to detect BASE-side edits. */
  contentHash: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ProductMaster = z.infer<typeof ProductMaster>;

/** A channel-specific listing derived from a ProductMaster row. */
export const ChannelListing = z.object({
  id: z.string().uuid(),
  productId: z.string().uuid(),
  channel: ChannelType,
  /** ID of the product/listing on the external channel (e.g. eBay offerId, BASE item_id). */
  externalId: z.string().nullable(),
  status: z.enum(["pending", "published", "update_pending", "error", "delisted"]),
  lastSyncedAt: z.coerce.date().nullable(),
  lastError: z.string().nullable().default(null),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type ChannelListing = z.infer<typeof ChannelListing>;

/** Central inventory truth. Every channel's stock is derived from this row. */
export const InventoryMaster = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().nonnegative(),
  /** Optimistic-lock version; every mutation must increment this to prevent double-sell races. */
  version: z.number().int().nonnegative(),
  soldOut: z.boolean(),
  updatedAt: z.coerce.date(),
});
export type InventoryMaster = z.infer<typeof InventoryMaster>;

/** Raw shape returned by a channel's product listing/detail API, before mapping to ProductMaster. */
export interface ExternalProduct {
  externalId: string;
  title: string;
  descriptionHtml: string;
  priceJpy: number;
  quantity: number;
  images: string[];
  updatedAt: Date;
}

export interface SaleEvent {
  channel: ChannelType;
  externalProductId: string;
  /** Idempotency source: same order should never be double-processed. */
  externalOrderId: string;
  quantitySold: number;
  occurredAt: Date;
}
