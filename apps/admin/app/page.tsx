"use client";

import Link from "next/link";
import { useState } from "react";
import { BoxIcon, CoinIcon, MenuIcon, SyncIcon, TrendUpIcon } from "@/components/icons";

// Illustrative only -- not a real tenant's listing. The platform never shows a channel
// price it hasn't actually synced (see channelListings.lastSyncedPriceJpy elsewhere in
// this app), so this example is clearly labeled as a sample rather than live data.
const EXAMPLE_LISTING = {
  titleJa: "ヴィンテージ リング ガーネット 9号",
  status: "承認待ち",
  ebayPriceUsd: 79.0,
  estimatedProfitJpy: 6200,
};

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
    title: "在庫自動同期",
    body: "BASEは最短15分、eBayは最短1分ごとに販売状況を自動チェックし、もう一方の在庫に反映します。売り違いのリスクを大きく減らせますが、在庫1点の商品は反映までのわずかな時間に同時受注が発生する可能性がゼロではありません。一点物を多く扱う場合は安全在庫の設定など運用上の工夫をおすすめします。",
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
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="landing">
      <header className="landing-topbar">
        <span className="app-brand landing-brand">
          <span className="app-brand-mark">AI</span>
          BASE <span className="app-brand-ebay">eBay</span> Sync
        </span>
        <div className="landing-topbar-actions">
          <Link href="/login" className="landing-login-link">
            ログイン
          </Link>
          <button
            type="button"
            className="landing-menu-button"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="メニュー"
            aria-expanded={menuOpen}
          >
            <MenuIcon />
          </button>
        </div>
      </header>

      {menuOpen && (
        <nav className="landing-mobile-menu">
          <a href="#features" onClick={() => setMenuOpen(false)}>
            できること
          </a>
          <a href="#how-it-works" onClick={() => setMenuOpen(false)}>
            使い方
          </a>
          <a href="#plan" onClick={() => setMenuOpen(false)}>
            ご利用プラン
          </a>
          <Link href="/login" onClick={() => setMenuOpen(false)}>
            ログイン
          </Link>
          <Link href="/signup" onClick={() => setMenuOpen(false)}>
            新規登録
          </Link>
        </nav>
      )}

      <section className="landing-hero">
        <h1>BASEの商品を、eBayへ。在庫と利益も、ひとつに。</h1>
        <p className="landing-hero-lead">
          AIが出品ドラフトを自動作成。内容を確認・承認するだけで出品でき、在庫同期や価格計算までまとめて行えます。
        </p>
        <div className="landing-hero-cta">
          <Link href="/signup" className="landing-cta-primary">
            導入について相談
          </Link>
          <Link href="/login" className="landing-cta-secondary">
            すでにアカウントをお持ちの方
          </Link>
        </div>
        <p className="landing-hero-note">招待制で先行導入を受付中</p>

        <div className="card landing-example-card">
          <span className="landing-example-tag">画面イメージ(サンプル)</span>
          <div className="match-card" style={{ marginTop: "0.6rem" }}>
            <div className="match-card-thumb" />
            <div style={{ flex: 1 }}>
              <div className="match-card-title">{EXAMPLE_LISTING.titleJa}</div>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.3rem" }}>
                <span className="badge">BASE</span>
                <span aria-hidden="true">→</span>
                <span className="badge">eBay</span>
                <span className="badge warn">{EXAMPLE_LISTING.status}</span>
              </div>
            </div>
          </div>
          <dl className="landing-example-figures">
            <div>
              <dt>想定価格(eBay)</dt>
              <dd>US ${EXAMPLE_LISTING.ebayPriceUsd.toFixed(2)}</dd>
            </div>
            <div>
              <dt>見込み利益</dt>
              <dd>約¥{EXAMPLE_LISTING.estimatedProfitJpy.toLocaleString()}</dd>
            </div>
          </dl>
          <p className="landing-example-disclaimer">※実際のデータではなく、イメージ例です。</p>
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

      <section id="features" className="landing-section">
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

      <section id="how-it-works" className="landing-section">
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

      <section id="plan" className="landing-section">
        <h2 className="landing-section-title">ご利用プラン</h2>
        <div className="card card-pad landing-plan-card">
          <div className="landing-plan-header">
            <strong>先行導入プラン</strong>
            <span className="badge">案</span>
          </div>
          <div className="landing-plan-price">
            <span className="landing-plan-price-amount">¥9,800</span>
            <span className="landing-plan-price-unit">/月(税別)</span>
          </div>
          <ul className="landing-plan-limits">
            <li>商品登録数 300点まで</li>
            <li>AI出品ドラフト生成 月100回まで</li>
            <li>BASE / eBay 連携、在庫同期、ダッシュボードなど全機能利用可能</li>
          </ul>
          <p className="landing-plan-note">
            初期設定費用 ¥19,800(税別)。金額は正式リリースに向けて検討中の案であり、確定した料金ではありません。商品登録数・AI生成回数の上限は実際に運用している値です。現在はベータ期間中のため、招待コードをお持ちの方のみご登録いただけます。
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
        <span>© BASE eBay Sync</span>
        <Link href="/login">ログイン</Link>
        <Link href="/signup">新規登録</Link>
      </footer>
    </div>
  );
}
