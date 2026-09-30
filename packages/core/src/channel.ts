import { z } from "zod";

/**
 * Supported sales channels. Adding a new one here (and implementing ChannelAdapter) is the
 * *starting* point, not the whole job -- see docs/adding-a-channel.md at the repo root for
 * what else needs to change (some of it automatic as of this codebase's channel-registry
 * pass, some of it still manual: CDK infra, and the sale-application outbox's current
 * single-other-channel assumption in particular).
 */
export const ChannelType = z.enum(["base", "ebay", "shopify", "amazon", "rakuten"]);
export type ChannelType = z.infer<typeof ChannelType>;

/** Channels that are fully implemented in this codebase today. */
export const IMPLEMENTED_CHANNELS: ChannelType[] = ["base", "ebay"];

/**
 * Every implemented channel except `channel` itself. With exactly 2 implemented channels
 * this returns a single-element array (today's "the other channel" case), but unlike a
 * hardcoded `channel === "base" ? "ebay" : "base"` ternary, this stays correct once a 3rd
 * channel is added to IMPLEMENTED_CHANNELS -- a sale on channel A must notify every other
 * channel holding stock, not just one.
 */
export function otherChannels(channel: ChannelType, allChannels: ChannelType[] = IMPLEMENTED_CHANNELS): ChannelType[] {
  return allChannels.filter((c) => c !== channel);
}
