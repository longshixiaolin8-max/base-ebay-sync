import { PublicDocument } from "@/components/PublicDocument";
import { DISCLOSURE_SUBJECT, LEGAL_INFO } from "@/lib/legal-config";

const ON_REQUEST = "請求があった場合に遅滞なく開示します";

export default function LegalPage() {
  const hasEmail = Boolean(LEGAL_INFO.email);
  const disclosureMailto =
    "mailto:" + LEGAL_INFO.email + "?subject=" + encodeURIComponent(DISCLOSURE_SUBJECT);

  return (
    <PublicDocument title="特定商取引法に基づく表記">
      <p>
        販売事業者の氏名または名称、所在地、電話番号は、特定商取引法第11条ただし書に基づき
        表示を省略しています。開示を希望される方には、契約の申込み前に確認いただけるよう、
        請求に応じて電子メール等で遅滞なく情報を提供します。
      </p>
      <dl style={{ display: "grid", gridTemplateColumns: "minmax(9rem, 13rem) 1fr", gap: "0.8rem 1rem" }}>
        <dt>販売事業者</dt><dd>{ON_REQUEST}</dd>
        <dt>所在地</dt><dd>{ON_REQUEST}</dd>
        <dt>電話番号</dt><dd>{ON_REQUEST}</dd>
        <dt>開示請求先・お問い合わせ</dt>
        <dd>
          {hasEmail ? (
            <a href={disclosureMailto}>{LEGAL_INFO.email}</a>
          ) : (
            <strong>お問い合わせ窓口は未設定です（本番公開前に設定が必要です）</strong>
          )}
        </dd>
        <dt>開示請求方法</dt>
        <dd>
          上記メールアドレス宛に、件名「{DISCLOSURE_SUBJECT}」としてご連絡ください。
          購入前の方も請求できます。開示請求自体に費用はかかりません。
        </dd>
        <dt>開示時期・方法</dt>
        <dd>契約の申込みの意思決定に先立って十分な時間的余裕をもって、電子メール等で遅滞なく提供します。</dd>
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
