import { EmptyState } from "@/components/Skeleton";
import type { ConnectionDetail } from "./types";

interface IsolationCardProps {
  base: ConnectionDetail | null;
  ebay: ConnectionDetail | null;
  confidenceScore: number | null;
}

function confidenceTone(score: number): string {
  if (score >= 90) return "var(--success)";
  if (score >= 70) return "var(--warn)";
  return "var(--danger)";
}

function confidenceLabel(score: number): string {
  if (score >= 90) return "良好な状態です";
  if (score >= 70) return "一部のジョブで再試行が発生していますが、システムは正常に稼働しています。";
  return "同期の信頼性が低下しています。同期エラーを確認してください。";
}

/**
 * "Isolated" here means computeChannelSyncState's ISOLATED state, not a persisted flag --
 * there is nothing to reset, it's a live snapshot that self-heals once the underlying
 * problem (see each channel's `reasons`) ages out of its detection window. See
 * packages/db/src/channel-isolation.ts for why this is deliberately stateless.
 */
export function IsolationCard({ base, ebay, confidenceScore }: IsolationCardProps) {
  const isolated = [
    base?.state === "ISOLATED" ? { channel: "BASE", reasons: base.reasons } : null,
    ebay?.state === "ISOLATED" ? { channel: "eBay", reasons: ebay.reasons } : null,
  ].filter((v): v is { channel: string; reasons: string[] } => v !== null);

  return (
    <div className="isolation-card">
      <h3>隔離チャネルの状態</h3>
      {isolated.length === 0 ? (
        <EmptyState>現在、隔離中のチャネルはありません。エラーが連続して発生したチャネルは自動的に隔離され、新規の公開・更新が一時停止されます。</EmptyState>
      ) : (
        <ul className="isolation-list">
          {isolated.map((item) => (
            <li key={item.channel}>
              <strong>{item.channel}</strong>
              <p>{item.reasons[0]}</p>
            </li>
          ))}
        </ul>
      )}

      <div className="confidence-gauge">
        <div className="confidence-gauge-head">
          <span>同期の信頼性</span>
        </div>
        {confidenceScore === null ? (
          <div className="confidence-gauge-loading">確認中...</div>
        ) : (
          <>
            <div className="confidence-gauge-value" style={{ color: confidenceTone(confidenceScore) }}>
              {confidenceScore}%
            </div>
            <div className="confidence-gauge-bar">
              <div className="confidence-gauge-bar-fill" style={{ width: `${confidenceScore}%`, background: confidenceTone(confidenceScore) }} />
            </div>
            <p className="confidence-gauge-note">{confidenceLabel(confidenceScore)}</p>
          </>
        )}
      </div>
    </div>
  );
}
