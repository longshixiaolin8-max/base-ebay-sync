import { z } from "zod";

/**
 * Supported sales channels. New channels (Shopify, Amazon, Rakuten, ...) are added
 * here and by implementing ChannelAdapter — no other core code needs to change.
 */
export const ChannelType = z.enum(["base", "ebay", "shopify", "amazon", "rakuten"]);
export type ChannelType = z.infer<typeof ChannelType>;

/** Channels that are fully implemented in this codebase today. */
export const IMPLEMENTED_CHANNELS: ChannelType[] = ["base", "ebay"];
