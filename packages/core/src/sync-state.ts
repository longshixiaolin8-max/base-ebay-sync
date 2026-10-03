import { z } from "zod";

/**
 * Item #8 of the commercial-features round ("同期状態をState Machine化"). Deliberately a
 * *derived* classification, not a persisted state with stored transitions -- consistent with
 * this codebase's existing stance (see @ai-ec/db's channel-isolation.ts: "no persisted
 * isolated flag to remember to clear"). computeChannelSyncState() in @ai-ec/db composes the
 * already-existing isChannelIsolated/computeSyncConfidence/reconstructInventory signals into
 * one of these five values on every read, so there is no separate state to drift from reality
 * or forget to transition back.
 */
export const ChannelSyncState = z.enum(["HEALTHY", "DEGRADED", "ISOLATED", "RECOVERING", "RECONCILING"]);
export type ChannelSyncState = z.infer<typeof ChannelSyncState>;
