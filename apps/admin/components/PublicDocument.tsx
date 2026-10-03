import Link from "next/link";
import type { ReactNode } from "react";

export function PublicDocument({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="landing" style={{ minHeight: "100dvh" }}>
      <header className="landing-topbar">
        <Link href="/" className="app-brand landing-brand">
          <span className="app-brand-mark">AI</span>
          BASE <span className="app-brand-ebay">eBay</span> Sync
        </Link>
        <div className="landing-topbar-actions">
          <Link href="/signup" className="landing-login-link">新規登録</Link>
          <Link href="/login" className="landing-login-link">ログイン</Link>
        </div>
      </header>
      <article className="landing-section" style={{ maxWidth: 860, lineHeight: 1.85 }}>
        <h1 className="landing-section-title" style={{ textAlign: "left" }}>{title}</h1>
        {children}
        <p style={{ marginTop: "2rem" }}><Link href="/">← トップに戻る</Link></p>
      </article>
    </main>
  );
}
