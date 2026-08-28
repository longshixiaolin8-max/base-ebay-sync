import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "AI EC運営プラットフォーム 管理画面",
  description: "BASE / eBay 商品・在庫同期管理画面",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
