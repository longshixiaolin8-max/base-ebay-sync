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
    steps: [
      "下の「正しい在庫数」で、BASEの入出庫履歴から自動計算した数値を確認してください。",
      "計算値が現在の登録在庫と異なる場合は、ボタンから反映してください。",
      "反映すると在庫が更新され、このエラーは解決済みになります。",
    ],
    retryable: false,
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
  possible_double_sale: {
    title: "同時受注の可能性",
    summary: "在庫が0になった直後に、もう一方の販路でも同じ商品の注文が入りました。",
    cause:
      "BASE・eBayともに「売れた瞬間」を即時通知する仕組みがなく、双方の在庫を0にするまでの短い間に両方で購入されてしまった可能性があります。システムは在庫の二重減算は自動的に防いでいますが、実際に成立してしまった注文そのものは自動キャンセルしていません。",
    steps: [
      "BASE・eBay双方の管理画面で、この商品の注文状況を確認してください。",
      "在庫を用意できない場合は、いずれか一方の注文をキャンセル・返金し、購入者へお詫びの連絡をしてください。",
      "対応が完了したら、このエラーを解決済みにしてください。",
    ],
    retryable: false,
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
  ebay_seller_setup_required: {
    title: "eBay出品者登録が必要です",
    summary: "eBayの販売者資格(Selling Privilege)が確認できず、出品・更新が拒否されました。",
    cause:
      "eBayアカウントが出品に必要な販売者登録(本人確認・支払い受取方法など)を完了していないか、アカウントに制限がかかっている可能性があります。多くの場合、支払い受取先として連携しているPayoneerの本人確認(KYC)がまだ完了していないことが原因です。接続の認証切れではないため、再接続では解決しません。",
    steps: [
      "eBayアプリ・サイトの「支払い」→「Verification Center」で、Payoneerの本人確認に未完了の項目がないか確認してください。",
      "すべて完了していても、eBay側への反映には数時間〜数日かかる場合があります。",
      "eBay Seller Hub(販売者ダッシュボード)でアカウント制限に関する通知が届いていないかも確認してください。",
      "登録完了後は自動では再送信されません。該当商品の在庫や価格を更新すると、次回の同期で自動的に再送信されます。",
    ],
    retryable: false,
  },
  ebay_publish_failed: {
    title: "eBayへの新規出品に失敗",
    summary: "eBayへの新規出品リクエストが失敗しました。",
    cause: "出品内容がeBayの出品規定を満たしていないか、eBay側のAPI障害が発生した可能性があります。",
    steps: ["商品のAI下書き内容(カテゴリ・商品特性など)を確認してください。", "繰り返し失敗する場合はサポートにご連絡ください。"],
    retryable: false,
  },
  ebay_update_failed: {
    title: "eBay出品の更新に失敗",
    summary: "既存のeBay出品への価格・在庫・内容の更新が失敗しました。",
    cause: "出品内容がeBayの出品規定を満たしていないか、eBay側のAPI障害が発生した可能性があります。",
    steps: ["商品の最新情報(価格・在庫・内容)を確認してください。", "繰り返し失敗する場合はサポートにご連絡ください。"],
    retryable: false,
  },
  ebay_sync_quota_exceeded: {
    title: "eBay同期回数の上限に達しました",
    summary: "今月のプランのeBay同期(出品・更新)回数の上限に達しました。",
    cause: "契約中のプランで利用できるeBay同期回数を使い切りました。来月になると自動的にリセットされます。",
    steps: ["来月の更新をお待ちいただくか、プランの変更をご検討ください。", "既に公開済みの出品は引き続き有効です。"],
    retryable: false,
    actionHref: "/billing",
    actionLabel: "請求・プランを確認",
  },
  ebay_tracking_sync_failed: {
    title: "eBayへの発送追跡番号の送信に失敗",
    summary: "発送した注文の追跡番号をeBayに送信できませんでした。",
    cause: "eBay側の一時的なAPI障害、またはネットワークの問題が考えられます。注文自体は発送済みとして記録されています。",
    steps: ["下の「再試行」で、同じ追跡番号を使って再送信できます。", "繰り返し失敗する場合はサポートにご連絡ください。"],
    retryable: true,
  },
  shipping_notice_email_failed: {
    title: "発送完了メールの送信に失敗",
    summary: "BASEの購入者への発送完了メールを送信できませんでした。",
    cause: "メール送信基盤(SES)が未承認・制限中か、一時的な障害が発生した可能性があります。自動の再送信は行われません。",
    steps: [
      "購入者へは、BASEの管理画面などから手動で発送完了をご連絡いただくことをおすすめします。",
      "繰り返し発生する場合はサポートにご連絡ください。",
    ],
    retryable: false,
  },
  product_fetch_dispatch_failed: {
    title: "商品取込後の同期ジョブ送信に失敗",
    summary: "BASEから商品情報自体は取り込めましたが、後続のAI出品/eBay同期ジョブの送信でエラーが発生しました。",
    cause: "システム内部の一時的な処理エラーです。",
    steps: ["再試行してください。", "繰り返し発生する場合はサポートにご連絡ください。"],
    retryable: true,
  },
  channel_inventory_push_failed: {
    title: "他チャネルへの在庫反映に失敗",
    summary: "一方の販路での販売を、もう一方の販路の在庫に反映できませんでした。",
    cause: "連携の認証切れ、またはチャネル側のAPI障害の可能性があります。",
    steps: ["対象チャネルの接続状態を確認してください。", "認証切れの場合は再接続してください。"],
    retryable: true,
  },
  offboarding_delist_failed: {
    title: "解約手続き中の出品取り下げに失敗",
    summary: "解約処理の一環で、公開中の出品を取り下げる処理が失敗しました。",
    cause: "チャネル側のAPI障害、または認証切れの可能性があります。",
    steps: ["時間をおいて自動的に再試行されます。", "繰り返し発生する場合はサポートにご連絡ください。"],
    retryable: false,
  },
  ebay_account_deletion_failed: {
    title: "eBayアカウント連携情報の削除に失敗",
    summary: "eBayからのアカウント削除通知を受けて行う、連携情報の削除処理が失敗しました。",
    cause: "システム内部の一時的な処理エラーです。",
    steps: ["時間をおいて自動的に再試行されます。", "繰り返し発生する場合はサポートにご連絡ください。"],
    retryable: false,
  },
};
