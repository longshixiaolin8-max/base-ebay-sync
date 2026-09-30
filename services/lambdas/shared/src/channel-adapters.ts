import { BaseAdapter } from "@ai-ec/adapter-base";
import type { ChannelAdapter, ChannelType } from "@ai-ec/core";
import { getAppCredentials } from "./secrets.js";
import { createEbayAdapter, type EbayAppCredentials } from "./ebay.js";

/** Was redeclared independently (with the same 2 fields) in oauth-base, product-fetch and
 *  tenant-offboarding's own handler.ts files -- one canonical export now that this module
 *  exists as the shared place for "today's implemented channels' credential shapes". */
export interface BaseAppCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Builds every currently-implemented channel's ChannelAdapter from Secrets Manager, in one
 * place. Previously hand-rolled independently (identically) in inventory-sync-worker,
 * inventory-diff-check and tenant-offboarding's own handler.ts files -- each one fetching
 * both credentials and constructing `{ base: new BaseAdapter(...), ebay: createEbayAdapter(...) }`
 * itself. Centralizing it here means a worker that needs "all of today's real channel
 * adapters" no longer needs its own copy of that wiring.
 *
 * Returns a Partial keyed by ChannelType, not a full Record, because IMPLEMENTED_CHANNELS
 * (see @ai-ec/core) is exactly {base, ebay} today -- shopify/amazon/rakuten simply have no
 * entry, same as every caller's inline object had before this refactor. Adding a real 3rd
 * channel means adding one line here, not editing 3 separate Lambda handlers.
 */
export async function loadImplementedChannelAdapters(): Promise<Partial<Record<ChannelType, ChannelAdapter>>> {
  const [baseCreds, ebayCreds] = await Promise.all([
    getAppCredentials<BaseAppCredentials>("base"),
    getAppCredentials<EbayAppCredentials>("ebay"),
  ]);
  return {
    base: new BaseAdapter(baseCreds),
    ebay: createEbayAdapter(ebayCreds),
  };
}
