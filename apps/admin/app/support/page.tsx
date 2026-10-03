import { PublicDocument } from "@/components/PublicDocument";
import { LEGAL_INFO } from "@/lib/legal-config";

export default function SupportPage() {
  return (
    <PublicDocument title="サポート">
      <p>BASE eBay Syncの導入、接続、同期エラー、請求、アカウント復旧に関するお問い合わせを受け付けています。</p>
      <p>お問い合わせ先: <a href={`mailto:${LEGAL_INFO.email}`}>{LEGAL_INFO.email}</a></p>
      <p>障害時は管理画面の「システム状態」「同期エラー」もあわせてご確認ください。</p>
    </PublicDocument>
  );
}
