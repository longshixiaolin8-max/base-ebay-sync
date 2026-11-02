import { z } from "zod";

/**
 * Supported sales channels. This is deliberately not "every marketplace that exists" --
 * each of these beyond base/ebay was chosen because a real competing Japanese EC一元管理
 * (multi-channel commerce sync) tool -- ネクストエンジン, CROSS MALL, GoQSystem -- already
 * integrates with it, not because it seemed generically popular:
 *   - amazon, rakuten: the two marketplaces every one of those 3 tools supports.
 *   - yahoo_shopping: the 3rd -- Amazon/楽天市場/Yahoo!ショッピングis the "big 3" every one
 *     of those tools lists as baseline coverage.
 *   - shopify: not a marketplace but a storefront platform like BASE itself -- included
 *     because CROSS MALL's own operator (アイル) is a certified Shopify Experts partner and
 *     Next Engine ships a dedicated Shopify sync app, i.e. real, confirmed demand, not a
 *     speculative "everyone uses Shopify" guess.
 * Adding a new one here (and implementing ChannelAdapter) is the *starting* point, not the
 * whole job -- see docs/adding-a-channel.md at the repo root for what else needs to change.
 * shopify is the proof this pipeline is genuinely N-channel-safe, not just 2-channel-safe
 * dressed up as general: the sale-application outbox (applySaleWithOutbox/dispatchPhaseB)
 * and the AI-draft pending-approval step (ai-generate-worker) both fan out to every entry in
 * IMPLEMENTED_CHANNELS already, with zero further edits needed when shopify was added here.
 */
export const ChannelType = z.enum(["base", "ebay", "shopify", "amazon", "rakuten", "yahoo_shopping"]);
export type ChannelType = z.infer<typeof ChannelType>;

/** Channels that are fully implemented in this codebase today. */
export const IMPLEMENTED_CHANNELS: ChannelType[] = ["base", "ebay", "shopify"];

/**
 * Every implemented channel except `channel` itself. Unlike a hardcoded
 * `channel === "base" ? "ebay" : "base"` ternary, this stays correct as channels are added to
 * IMPLEMENTED_CHANNELS -- a sale on channel A must notify every other channel holding stock,
 * not just one.
 */
export function otherChannels(channel: ChannelType, allChannels: ChannelType[] = IMPLEMENTED_CHANNELS): ChannelType[] {
  return allChannels.filter((c) => c !== channel);
}
