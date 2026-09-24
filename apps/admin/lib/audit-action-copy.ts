/**
 * Human-readable Japanese labels for every audit_log `action` value this platform actually
 * records (grepped from every recordAuditLog call site across admin-api and every worker
 * Lambda, not a guess at possible future actions). Shared between the commerce page's
 * "最近の同期" list and the full 監査ログ page.
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  ai_listing_generated: "AIが出品ドラフトを生成しました",
  ai_draft_condition_corrected: "AI下書きのコンディションを修正しました",
  ai_draft_item_specifics_corrected: "AI下書きのItem Specificsを修正しました",
  ai_draft_stale_regeneration_triggered: "滞留商品のAI下書き再生成を実行しました",
  ebay_listing_publish_approved: "eBay出品を承認しました",
  ebay_listing_published: "eBayへ出品しました",
  ebay_listing_updated: "eBay出品を更新しました",
  ebay_listing_linked: "既存のeBay出品を紐付けしました",
  ebay_inventory_location_created: "eBayの在庫拠点を作成しました",
  ebay_business_policies_created: "eBayの事業者ポリシーを作成しました",
  ebay_webhook_subscribed: "eBay Webhookを登録しました",
  sync_error_retried: "同期エラーを再試行しました",
  inventory_reconstructed: "在庫を再構築しました",
  auto_rollback_applied: "自動ロールバックを適用しました",
  anomaly_detected_sync_paused: "異常検知により同期を一時停止しました",
  other_channel_isolated_skip: "他チャネル分離のため同期をスキップしました",
  channel_isolated_skip: "チャネル分離のため同期をスキップしました",
  product_listed_base: "BASEから商品を取り込みました",
  product_purchased: "商品の購入(仕入)を記録しました",
  product_price_changed: "価格を変更しました",
  pricing_config_updated: "価格設定を更新しました",
  order_status_changed: "注文状態を更新しました",
  order_profit_finalized: "利益を確定しました",
  sns_script_generated: "SNS台本を生成しました",
  sns_status_updated: "SNS状況を更新しました",
  subscription_cancel_scheduled: "契約解約を予約しました",
  oauth_connected: "外部アカウントを接続しました",
  dlq_redrive_started: "失敗ジョブの再処理を開始しました",
};
