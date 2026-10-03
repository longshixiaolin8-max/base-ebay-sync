"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BoxIcon, CoinIcon, MenuIcon, SyncIcon, TrendUpIcon } from "@/components/icons";
import { publicApiGet } from "@/lib/api-client";

interface PublicPricing {
  unitAmount: number;
  currency: string;
  interval: string;
  trialDays: number;
  live: boolean;
}

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
    body: "BASEの商品情報から、英語タイトル・説明文・eBayカテゴリ/item specificsをAIが自動生成。内容を確認して承認するまでeBayへ公開しません。",
  },
  {
    icon: SyncIcon,
    title: "BASE / eBay 在庫自動同期",
    body: "中央在庫マスターを介して販売状況を自動確認し、もう一方の在庫へ反映。冪等性・楽観ロック・安全在庫で売り違いリスクを抑えます。",
  },
  {
    icon: CoinIcon,
    title: "価格・利益管理",
    body: "為替、送料、仕入れ、手数料、目標利益率から販売判断を支援。売上と利益を同じ管理画面で確認できます。",
  },
  {
    icon: TrendUpIcon,
    title: "運用ダッシュボード",
    body: "注文、同期状態、エラー、監査ログ、分析を一元管理。同期失敗は再試行キューとDLQで追跡できます。",
  },
];

const STEPS = [
  "無料アカウントを作成し、メールアドレスを確認",
  "Stripeでお支払い方法を登録し、BASE / eBayをOAuth接続",
  "AI下書きを確認・承認してeBayへ出品。在庫・注文は自動同期",
];

function priceLabel(pricing: PublicPricing | null): string {
  if (!pricing) return "料金を取得中";
  const amount = pricing.unitAmount / 100;
  const value = new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: pricing.currency.toUpperCase(),
    maximumFractionDigits: pricing.currency.toLowerCase() === "jpy" ? 0 : 2,
  }).format(amount);
  return `${value} / ${pricing.interval === "month" ? "月" : pricing.interval}`;
}

export default function LandingPage() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pricing, setPricing] = useState<PublicPricing | null>(null);
  const [signupReady, setSignupReady] = useState(true);

  useEffect(() => {
    publicApiGet<PublicPricing>("/public/pricing")
      .then((res) => {
        setPricing(res);
        setSignupReady(true);
      })
      .catch(() => setSignupReady(false));
  }, []);

  return (
    <div className="landing">
      <header className="landing-topbar">
        <Link href="/" className="app-brand landing-brand">
          <span className="app-brand-mark">AI</span>
          BASE <span className="app-brand-ebay">eBay</span> Sync
        </Link>
        <div className="landing-topbar-actions">
          <Link href="/login" className="landing-login-link">ログイン</Link>
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
          <a href="#features" onClick={() => setMenuOpen(false)}>できること</a>
          <a href="#how-it-works" onClick={() => setMenuOpen(false)}>使い方</a>
          <a href="#plan" onClick={() => setMenuOpen(false)}>料金</a>
          <Link href="/signup" onClick={() => setMenuOpen(false)}>新規登録</Link>
          <Link href="/login" onClick={() => setMenuOpen(false)}>ログイン</Link>
        </nav>
      )}

      <section className="landing-hero">
        <h1>BASEの商品を、eBayへ。在庫と利益も、ひとつに。</h1>
        <p className="landing-hero-lead">
          AIがeBay向け出品ドラフトを作成。人が確認・承認して公開し、BASEとeBayの在庫・注文・利益管理までひとつの画面で運用できます。
        </p>
        <div className="landing-hero-cta">
          <Link href="/signup" className="landing-cta-primary" aria-disabled={!signupReady}>
            {signupReady ? "無料で始める" : "新規受付状況を確認中"}
          </Link>
          <a href="#how-it-works" className="landing-cta-secondary">使い方を見る</a>
        </div>
        <p className="landing-hero-note">
          メール確認・MFA対応。{pricing ? `${pricing.trialDays}日間無料 / いつでも解約可能` : "料金は登録前に確認できます"}
        </p>

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
          <p className="landing-example-disclaimer">※実際の利用者データではなく、画面説明用のサンプルです。</p>
        </div>
      </section>

      <section className="landing-section">
        <h2 className="landing-section-title">こんな悩みをまとめて解決</h2>
        <ul className="landing-pain-list">
          {PAIN_POINTS.map((point) => <li key={point}>{point}</li>)}
        </ul>
      </section>

      <section id="features" className="landing-section">
        <h2 className="landing-section-title">できること</h2>
        <div className="landing-feature-grid">
          {FEATURES.map((feature) => {
            const Icon = feature.icon;
            return (
              <div key={feature.title} className="card card-pad landing-feature-card">
                <span className="landing-feature-icon"><Icon /></span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      <section id="how-it-works" className="landing-section">
        <h2 className="landing-section-title">今日から使い始めるまで</h2>
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
        <h2 className="landing-section-title">料金</h2>
        <div className="card card-pad landing-plan-card">
          <div className="landing-plan-header">
            <strong>スタンダード</strong>
            {pricing && <span className="badge ok">{pricing.trialDays}日間無料</span>}
          </div>
          <div className="landing-plan-price">
            <span className="landing-plan-price-amount">{signupReady ? priceLabel(pricing) : "新規受付準備中"}</span>
          </div>
          <ul className="landing-plan-limits">
            <li>商品登録数 300点まで</li>
            <li>AI出品ドラフト生成 月100回まで</li>
            <li>BASE / eBay連携、在庫・注文同期、分析、監査ログ、同期エラー管理</li>
          </ul>
          <p className="landing-plan-note">
            実際の請求額・通貨・請求周期はStripe Checkoutに表示される内容が最終確認画面です。
            無料期間終了前に解約した場合、その後の継続課金は行われません。
          </p>
          <Link href="/signup" className="landing-cta-primary">アカウントを作成する</Link>
        </div>
      </section>

      <section className="landing-section landing-footer-cta">
        <h2 className="landing-section-title">BASEから海外販売を始める</h2>
        <p className="landing-hero-lead">登録からメール確認、決済設定、BASE/eBay接続までオンラインで完結します。</p>
        <Link href="/signup" className="landing-cta-primary">無料で始める</Link>
      </section>

      <footer className="landing-footer" style={{ flexWrap: "wrap" }}>
        <span>© BASE eBay Sync</span>
        <Link href="/terms">利用規約</Link>
        <Link href="/privacy">プライバシー</Link>
        <Link href="/legal">特商法表記</Link>
        <Link href="/support">サポート</Link>
        <Link href="/login">ログイン</Link>
      </footer>
    </div>
  );
}
