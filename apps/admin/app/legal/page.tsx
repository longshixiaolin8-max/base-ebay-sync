import { PublicDocument } from "@/components/PublicDocument";
import { LEGAL_INFO } from "@/lib/legal-config";

export default function LegalPage() {
  return (
    <PublicDocument title="特定商取引法に基づく表記">
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(9rem, 13rem) 1fr", gap: "0.8rem 1rem" }}>
        <dt>販売事業者</dt><dd>{LEGAL_INFO.operatorName}</dd>
        <dt>所在地</dt><dd>{LEGAL_INFO.address}</dd>
        <dt>電話番号</dt><dd>{LEGAL_INFO.phone}</dd>
        <dt>メールアドレス</dt><dd>{LEGAL_INFO.email}</dd>
        <dt>販売価格</dt><dd>申込画面およびStripe Checkoutに表示される価格</dd>
        <dt>販売価格以外の費用</dt><dd>インターネット接続料金・通信料金等は利用者負担</dd>
        <dt>支払方法</dt><dd>Stripeが提供するクレジットカード等の決済方法</dd>
        <dt>支払時期</dt><dd>無料期間終了後および以後の各請求周期開始時。具体的な日付は請求画面に表示</dd>
        <dt>サービス提供時期</dt><dd>登録・メール確認・決済設定の完了後、直ちに利用可能</dd>
        <dt>解約</dt><dd>管理画面の請求設定から次回更新日前までに手続き可能</dd>
        <dt>返品・返金</dt><dd>デジタルサービスの性質上、提供済み期間については法令上必要な場合を除き返金しません</dd>
      </dl>
    </PublicDocument>
  );
}
