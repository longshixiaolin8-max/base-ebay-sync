/**
 * Human-readable Japanese copy for every errorCode this platform's workers actually emit
 * (grepped from every recordSyncError call site in services/lambdas -- not a guess at
 * possible future codes). Kept as a small static lookup rather than a backend change,
 * since the raw errorCode/errorMessage the API already returns is all the information
 * there is to translate.
 */
export interface ErrorCodeCopy {
  title: string;
  summary: string;
  cause: string;
  steps: string[];
  /** Which channel's OAuth reconnect link is relevant, if any. */
  reconnectChannel?: "base" | "ebay";
  /** Whether a plain retry of the same job is actually useful for this error. */
  retryable: boolean;
  /** Route to send the user to instead of retrying (e.g. a plan/quota limit). */
  actionHref?: string;
  actionLabel?: string;
}

export const ERROR_CODE_LABEL: Record<string, ErrorCodeCopy> = {
  inventory_drift: {
    title: "在庫の食い違いを検出",
    summary: "BASEとeBayで在庫数が一致していません。",
    cause: "同期のタイミングのずれ、または一方の販路で手動編集があった可能性があります。自動では補正していません。",
    steps: ["実際の在庫数を確認してください。", "下の「現在の在庫」を確認し、想定と違う場合は商品ページから在庫を修正してください。", "修正後、再試行で同期状態を再確認してください。"],
    retryable: true,
  },
  inventory_sync_failed: {
    title: "在庫の同期に失敗",
    summary: "在庫の更新をBASE/eBayに反映できませんでした。",
    cause: "連携の認証切れ、またはBASE/eBay側のAPI障害の可能性があります。",
    steps: ["対象チャネルの接続状態を確認してください。", "認証切れの場合は再接続してください。", "再接続後、再試行してください。"],
    retryable: true,
  },
  product_fetch_failed: {
    title: "BASEからの商品取込に失敗",
    summary: "BASEの商品情報を取得できませんでした。",
    cause: "BASE連携の認証切れ、またはBASE側のAPI障害の可能性があります。",
    steps: ["BASE連携の状態を確認してください。", "認証切れの場合は再接続してください。"],
    reconnectChannel: "base",
    retryable: true,
  },
  sales_poll_failed: {
    title: "販売状況の取得に失敗",
    summary: "注文・売上情報を取得できませんでした。",
    cause: "連携の認証切れ、またはチャネル側のAPI障害の可能性があります。",
    steps: ["対象チャネルの接続状態を確認してください。", "認証切れの場合は再接続してください。"],
    retryable: true,
  },
  ai_generate_failed: {
    title: "AI出品ドラフトの生成に失敗",
    summary: "AIによる出品ドラフトの作成でエラーが発生しました。",
    cause: "AIサービスの一時的な不調、または商品情報が生成に適さない可能性があります。",
    steps: ["時間をおいて再試行してください。", "繰り返し失敗する場合は商品情報(タイトル・説明)を確認してください。"],
    retryable: true,
  },
  order_record_failed: {
    title: "注文情報の記録に失敗",
    summary: "受注情報の内部記録処理でエラーが発生しました。",
    cause: "システム内部の一時的な処理エラーです。",
    steps: ["再試行してください。", "繰り返し発生する場合はサポートにご連絡ください。"],
    retryable: true,
  },
  inventory_diff_check_failed: {
    title: "在庫整合性チェックに失敗",
    summary: "在庫の整合性を確認する処理自体が失敗しました。",
    cause: "システム内部の一時的な処理エラーです。",
    steps: ["再試行してください。", "繰り返し発生する場合はサポートにご連絡ください。"],
    retryable: true,
  },
  ai_quota_exceeded: {
    title: "AI生成回数の上限に達しました",
    summary: "今月のプランのAI生成回数の上限に達しました。",
    cause: "契約中のプランで利用できるAI生成回数を使い切りました。",
    steps: ["来月の更新をお待ちいただくか、プランの変更をご検討ください。", "既存商品の同期は引き続き行われます。"],
    retryable: false,
    actionHref: "/billing",
    actionLabel: "請求・プランを確認",
  },
  product_quota_exceeded: {
    title: "商品登録数の上限に達しました",
    summary: "契約中のプランの商品登録数の上限に達しました。",
    cause: "この商品は上限を超えているため新規登録されませんでした。",
    steps: ["プランの変更をご検討いただくか、既存の商品を整理してください。", "既存商品の同期は引き続き行われます。"],
    retryable: false,
    actionHref: "/billing",
    actionLabel: "請求・プランを確認",
  },
};
