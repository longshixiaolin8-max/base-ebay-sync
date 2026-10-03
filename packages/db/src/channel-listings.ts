import { and, eq, sql } from "drizzle-orm";
import type { Queryable } from "./usage.js";
import { channelListings } from "./schema.js";

/**
 * "When did this channel last successfully sync?", for the チャネル同期 connection-status
 * cards -- the max lastSyncedAt across every listing already synced to this channel. Null
 * only when nothing has ever synced (a brand-new tenant/channel), not on an ordinary quiet
 * period.
 */
export async function getLatestSyncedAt(db: Queryable, tenantId: string, channel: string): Promise<Date | null> {
  const [row] = await db
    .select({ latest: sql<string | null>`max(${channelListings.lastSyncedAt})` })
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.channel, channel)));
  return row?.latest ? new Date(row.latest) : null;
}

/**
 * A real, cheap `COUNT(*)` over channel_listings -- used everywhere this platform needs
 * "how many of this tenant's listings on channel X are in status Y" as a single number
 * (dashboard KPIs, the products list's KPI row), rather than each call site re-deriving it
 * from a full row fetch or, worse, each call site writing its own copy of this query.
 */
export async function countChannelListingsByStatus(
  db: Queryable,
  tenantId: string,
  channel: string,
  status: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(channelListings)
    .where(and(eq(channelListings.tenantId, tenantId), eq(channelListings.channel, channel), eq(channelListings.status, status)));
  return row?.count ?? 0;
}
