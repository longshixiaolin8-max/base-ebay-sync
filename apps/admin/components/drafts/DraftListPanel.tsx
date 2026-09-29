import type { DraftListItem } from "./types";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/Skeleton";

function confidenceTone(score: number): BadgeTone {
  if (score >= 90) return "ok";
  if (score >= 70) return "info";
  return "warn";
}

const dateFormatter = new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

interface DraftListPanelProps {
  drafts: DraftListItem[];
  selectedProductId: string | null;
  onSelect: (productId: string) => void;
}

export function DraftListPanel({ drafts, selectedProductId, onSelect }: DraftListPanelProps) {
  if (drafts.length === 0) {
    return <EmptyState>レビュー待ちの下書きはありません。</EmptyState>;
  }
  return (
    <ul className="draft-list">
      {drafts.map((d) => (
        <li key={d.id}>
          <button type="button" className="draft-list-item" data-active={d.productId === selectedProductId} onClick={() => onSelect(d.productId)}>
            {d.images[0] ? (
              <img src={d.images[0]} alt="" className="draft-list-thumb" />
            ) : (
              <div className="draft-list-thumb draft-list-thumb-empty" aria-hidden="true" />
            )}
            <div className="draft-list-body">
              <div className="draft-list-title">{d.title}</div>
              <div className="draft-list-badges">
                <Badge tone={confidenceTone(d.confidenceScore)}>{d.confidenceScore}%</Badge>
                {d.needsHumanReview && <Badge tone="warn">要確認</Badge>}
                {d.sourceMismatch && <Badge tone="error">ソース内容不一致</Badge>}
              </div>
              {d.categoryLabel && <div className="draft-list-category">{d.categoryLabel}</div>}
              <div className="draft-list-time">{dateFormatter.format(new Date(d.createdAt))}</div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
