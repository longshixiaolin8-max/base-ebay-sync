import type { ReactNode } from "react";

export function SkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <div className="skeleton-rows" aria-label="読み込み中" role="status">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state">{children}</div>;
}
