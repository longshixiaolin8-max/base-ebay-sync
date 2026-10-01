import type { ChannelSyncState } from "@ai-ec/core";
import type { ReactNode } from "react";

export type BadgeTone = "neutral" | "ok" | "warn" | "error" | "info" | "ai";

interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  /** Native tooltip -- e.g. the full error message behind an "error" tone badge, too long
   *  to fit in the badge itself. */
  title?: string;
}

/** Thin wrapper around the existing `.badge` utility class (see globals.css) -- kept as a
 *  component so every caller picks a tone from this fixed set instead of hand-writing
 *  className strings, and so the tone→color mapping lives in exactly one place. */
export function Badge({ tone = "neutral", children, title }: BadgeProps) {
  return (
    <span className={`badge${tone === "neutral" ? "" : ` ${tone}`}`} title={title}>
      {children}
    </span>
  );
}

const SYNC_STATE_LABEL: Record<ChannelSyncState, string> = {
  HEALTHY: "正常",
  DEGRADED: "低下",
  ISOLATED: "停止中",
  RECOVERING: "復旧中",
  RECONCILING: "調整中",
};

const SYNC_STATE_TONE: Record<ChannelSyncState, BadgeTone> = {
  HEALTHY: "ok",
  DEGRADED: "warn",
  ISOLATED: "error",
  RECOVERING: "warn",
  RECONCILING: "warn",
};

/** computeChannelSyncState's own 5-state classification (packages/db/src/sync-state.ts),
 *  translated to the same tone/label pair everywhere it's shown (sidebar, dashboard,
 *  topology card) instead of each caller re-deriving it. */
export function StatusBadge({ state }: { state: ChannelSyncState }) {
  return <Badge tone={SYNC_STATE_TONE[state]}>{SYNC_STATE_LABEL[state]}</Badge>;
}

export type TaskPriority = "high" | "medium" | "low";

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: "高", medium: "中", low: "低" };
const PRIORITY_TONE: Record<TaskPriority, BadgeTone> = { high: "error", medium: "warn", low: "neutral" };

export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{PRIORITY_LABEL[priority]}</Badge>;
}
