import { EmptyState } from "@/components/Skeleton";
import { AlertIcon, CheckIcon, TrendUpIcon } from "@/components/icons";
import type { Insight } from "./types";

const TONE_ICON: Record<Insight["tone"], typeof AlertIcon> = {
  info: TrendUpIcon,
  warn: AlertIcon,
  ok: CheckIcon,
};

/**
 * Each card is a live, rule-based comparison computed at request time (see the API route's
 * own insights logic, gated by a minimum real gap so routine noise never surfaces) -- not a
 * stored/logged event, so there's no real historical timestamp to show per card (a fabricated
 * "2時間前" would misrepresent when this was actually true).
 */
export function InsightsPanel({ insights }: { insights: Insight[] }) {
  if (insights.length === 0) {
    return <EmptyState>この期間に特筆すべき変化はありません。</EmptyState>;
  }

  return (
    <ul className="insights-list">
      {insights.map((insight, i) => {
        const Icon = TONE_ICON[insight.tone];
        return (
          <li key={i} className="insight-item" data-tone={insight.tone}>
            <span className="insight-icon">
              <Icon width={16} height={16} />
            </span>
            <p>{insight.message}</p>
          </li>
        );
      })}
    </ul>
  );
}
