import { BoxIcon, TagIcon } from "@/components/icons";

export type DisplayedChannel = "base" | "ebay";

/**
 * Single source of truth for "how a channel looks in the UI" -- previously duplicated
 * independently in ConnectionCard.tsx and ConnectionsTab.tsx (same 2 entries, same shape,
 * kept in sync by hand). Mirrors @ai-ec/core's IMPLEMENTED_CHANNELS: adding a real 3rd
 * channel means adding one entry here (and to DISPLAYED_CHANNELS below), not editing every
 * component that renders a channel card.
 */
export const CHANNEL_META: Record<DisplayedChannel, { icon: typeof BoxIcon; title: string; subtitle: string }> = {
  base: { icon: BoxIcon, title: "BASE", subtitle: "自社ストア" },
  ebay: { icon: TagIcon, title: "eBay", subtitle: "海外マーケット" },
};

/** The channels this platform's UI actually renders a connection card for today. */
export const DISPLAYED_CHANNELS: DisplayedChannel[] = ["base", "ebay"];
