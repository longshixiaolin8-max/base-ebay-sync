import { and, desc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { auditLog, inventoryEvents, syncErrors } from "./schema.js";

export interface SyncTraceEntry {
  source: "inventory_event" | "audit_log" | "sync_error";
  occurredAt: Date;
  summary: string;
  detail: Record<string, unknown>;
}

export interface SyncTraceResult {
  productId: string;
  entries: SyncTraceEntry[];
}

const DEFAULT_LIMIT = 100;

function summarizeInventoryEvent(e: typeof inventoryEvents.$inferSelect): string {
  const outcome = e.applied ? "applied" : `skipped (${e.skippedReason ?? "unknown reason"})`;
  if (e.eventType === "sale") return `${e.channel} sale: -${e.quantityDelta ?? 0} units [${outcome}]`;
  if (e.eventType === "base_stock_report") return `${e.channel} stock report: quantity=${e.absoluteQuantity} [${outcome}]`;
  return `${e.channel} ${e.eventType} [${outcome}]`;
}

/**
 * Item #1 of the third hardening round ("同期原因追跡 -- 「なぜ在庫が3→2になったか」を
 * イベント単位で完全追跡できる監査ログ"). This platform already records every quantity
 * change (inventory_events, item #1 of the first round), every notable system action
 * (audit_log), and every failure (sync_errors) for a product -- but each lives in its own
 * table, so answering "why" today means manually cross-referencing three separate queries
 * by timestamp. This merges all three into one chronological trace instead of introducing
 * a fourth table: a real inventory number change is always exactly one inventory_events row
 * (an applied sale or BASE stock report), and this shows what else was happening around it
 * -- a stale-content block, a rollback, an isolation skip, an anomaly pause, a real error --
 * without guessing which of three tables to check next.
 */
export async function traceSyncHistory(db: Database, productId: string, limit = DEFAULT_LIMIT): Promise<SyncTraceResult> {
  const [events, auditRows, errorRows] = await Promise.all([
    db.select().from(inventoryEvents).where(eq(inventoryEvents.productId, productId)).orderBy(desc(inventoryEvents.sequenceAt)).limit(limit),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "product"), eq(auditLog.entityId, productId)))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit),
    db.select().from(syncErrors).where(eq(syncErrors.productId, productId)).orderBy(desc(syncErrors.createdAt)).limit(limit),
  ]);

  const entries: SyncTraceEntry[] = [
    ...events.map((e) => ({
      source: "inventory_event" as const,
      occurredAt: e.sequenceAt,
      summary: summarizeInventoryEvent(e),
      detail: {
        channel: e.channel,
        eventType: e.eventType,
        quantityDelta: e.quantityDelta,
        absoluteQuantity: e.absoluteQuantity,
        applied: e.applied,
        skippedReason: e.skippedReason,
        externalEventId: e.externalEventId,
      },
    })),
    ...auditRows.map((a) => ({
      source: "audit_log" as const,
      occurredAt: a.createdAt,
      summary: `${a.actor}: ${a.action}`,
      detail: { before: a.before, after: a.after },
    })),
    ...errorRows.map((e) => ({
      source: "sync_error" as const,
      occurredAt: e.createdAt,
      summary: `${e.channel ?? "unknown channel"} ${e.errorCode}: ${e.errorMessage}`,
      detail: { payload: e.payload },
    })),
  ];

  entries.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return { productId, entries };
}
