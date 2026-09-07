import Link from "next/link";
import { BoxIcon, CheckIcon, CoinIcon, SyncIcon, TrendUpIcon } from "@/components/icons";

const PAIN_POINTS = [
  "英語での商品説明・出品作業に時間と語学力が必要",
  "BASEとeBay、在庫を手作業で二重管理すると売り違いのリスクがある",
  "為替・送料・利益率を考えた価格設定が面倒",
  "出品作業に割ける時間がなく、海外販売に踏み出せない",
];

const FEATURES = [
  {
    icon: BoxIcon,
    title: "AIによる自動出品ドラフト作成",
    body: "BASEの商品情報から、英語タイトル・説明文・eBayカテゴリ/item specificsをAIが自動生成。内容を確認して承認するだけで出品できます。",
  },
  {
    icon: SyncIcon,
    title: "リアルタイム在庫同期",
    body: "BASE・eBay間の在庫を自動同期し、売り違い(二重販売)を防止。どちらかで売れれば、もう一方の在庫も即座に反映されます。",
  },
  {
    icon: CoinIcon,
    title: "動的価格計算",
    body: "為替レート・送料・目標利益率から、eBay向けの適正価格を自動算出。商品ごとに送料や利益率を調整できます。",
  },
  {
    icon: TrendUpIcon,
    title: "売上・利益ダッシュボード + 滞留商品AI提案",
    body: "チャネル別の売上・利益推移をひと目で確認。長期間売れていない商品には、AIが価格改定などの改善案を提案します。",
  },
];

const STEPS = ["BASEアカウントを連携", "AIが自動でeBay出品ドラフトを作成", "内容を確認して承認するだけで出品、在庫は自動同期"];

export default function LandingPage() {
  return (
    <div className="landing">
      <header className="landing-topbar">
        <span className="app-brand landing-brand">
          <span className="app-brand-mark">AI</span>
          AI EC運営プラットフォーム
        </span>
        <Link href="/login" className="landing-login-link">
          ログイン
        </Link>
      </header>

      <section className="landing-hero">
        <h1>BASEの商品を、そのままeBayへ。海外販売を自動化。</h1>
        <p className="landing-hero-lead">
          BASEで販売中の商品をAIが自動でeBay向けに翻訳・出品。在庫同期から価格計算、売上管理まで、
          海外販売に必要な作業をひとつのプラットフォームでまとめて自動化します。
        </p>
        <div className="landing-hero-cta">
          <Link href="/signup" className="landing-cta-primary">
            招待コードで登録する
          </Link>
          <Link href="/login" className="landing-cta-secondary">
            すでにアカウントをお持ちの方
          </Link>
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">こんな悩みはありませんか?</h2>
        <ul className="landing-pain-list">
          {PAIN_POINTS.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">できること</h2>
        <div className="landing-feature-grid">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="card card-pad landing-feature-card">
                <span className="landing-feature-icon">
                  <Icon />
                </span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">使い方</h2>
        <ol className="landing-steps">
          {STEPS.map((step, i) => (
            <li key={step}>
              <span className="landing-step-number">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">ご利用プラン</h2>
        <div className="card card-pad landing-plan-card">
          <div className="landing-plan-header">
            <strong>スタンダードプラン</strong>
            <span className="badge ok">
              <CheckIcon /> ベータ提供中
            </span>
          </div>
          <ul className="landing-plan-limits">
            <li>商品登録数 300点まで</li>
            <li>AI出品ドラフト生成 月100回まで</li>
            <li>BASE / eBay 連携、在庫同期、ダッシュボードなど全機能利用可能</li>
          </ul>
          <p className="landing-plan-note">
            現在はベータ期間中のため、招待コードをお持ちの方のみご登録いただけます。料金プランは正式リリース時にご案内します。
          </p>
        </div>
      </section>

      <section className="landing-section landing-footer-cta">
        <h2 className="landing-section-title">招待コードをお持ちの方へ</h2>
        <p className="landing-hero-lead">今すぐ登録して、AIによる自動出品を試してみましょう。</p>
        <Link href="/signup" className="landing-cta-primary">
          招待コードで登録する
        </Link>
      </section>

      <footer className="landing-footer">
        <span>© AI EC運営プラットフォーム</span>
        <Link href="/login">ログイン</Link>
        <Link href="/signup">新規登録</Link>
      </footer>
    </div>
  );
}
