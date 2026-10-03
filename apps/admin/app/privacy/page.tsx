import { PublicDocument } from "@/components/PublicDocument";
import { LEGAL_INFO, PRIVACY_VERSION } from "@/lib/legal-config";

export default function PrivacyPage() {
  return (
    <PublicDocument title="プライバシーポリシー">
      <p>制定・改定日: {PRIVACY_VERSION}</p>
      <p>{LEGAL_INFO.operatorName}（以下「運営者」）は、本サービスで取り扱う情報を以下の方針で管理します。</p>
      <h2>取得する情報</h2>
      <p>
        氏名・事業者名・メールアドレス、認証情報に関する識別子、契約・請求状態、BASE/eBayから利用者の許可に基づき取得する
        商品・在庫・注文情報、操作履歴、障害・アクセスログ等を取得します。カード番号そのものはStripeが取り扱い、本サービスでは保存しません。
      </p>
      <h2>利用目的</h2>
      <p>
        本サービスの提供、本人確認、外部サービス連携、在庫・注文同期、AI出品支援、請求、サポート、
        不正利用防止、障害解析、品質改善、法令対応のために利用します。
      </p>
      <h2>外部サービス・委託</h2>
      <p>
        AWS、Stripe、BASE、eBayおよびAI提供基盤等を、本サービス提供に必要な範囲で利用します。
        各社への情報送信は利用目的の達成に必要な範囲に限定します。
      </p>
      <h2>安全管理</h2>
      <p>
        OAuthトークンはSecrets Managerで管理し、MFA、アクセス制御、監査ログ、暗号化、レート制御等の安全管理措置を講じます。
      </p>
      <h2>保存期間・削除</h2>
      <p>
        契約・法令・障害対応に必要な期間情報を保持し、不要となった情報は合理的な期間内に削除または匿名化します。
        法令上保存が必要な情報は当該期間保持します。
      </p>
      <h2>開示等の請求</h2>
      <p>本人からの開示、訂正、利用停止、削除等の請求について、適用法令に従い対応します。</p>
      <h2>お問い合わせ</h2>
      <p>連絡先: {LEGAL_INFO.email}</p>
    </PublicDocument>
  );
}
