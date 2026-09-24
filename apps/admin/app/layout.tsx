import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { MobileNavProvider } from "@/components/MobileNav";
import { Sidebar } from "@/components/Sidebar";
import { SidebarBackdrop } from "@/components/SidebarBackdrop";
import { ToastProvider } from "@/components/Toast";

export const metadata: Metadata = {
  title: "BASE eBay Sync 管理画面",
  description: "BASE / eBay 商品・在庫同期管理画面",
};

// Applies a previously-chosen manual theme before first paint, so a viewer who picked
// "dark" (or "light") via the sidebar's toggle doesn't see a flash of the OS-default theme
// while ThemeToggle's own effect runs. Safe with no explicit choice stored yet: the
// attribute is simply left unset and globals.css's prefers-color-scheme block applies.
const NO_FLASH_THEME_SCRIPT = `
try {
  var t = localStorage.getItem("admin-theme");
  if (t === "dark" || t === "light") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME_SCRIPT }} />
      </head>
      <body>
        <ToastProvider>
          <MobileNavProvider>
            <div className="app-shell">
              <Sidebar />
              <SidebarBackdrop />
              <div className="app-main">{children}</div>
            </div>
          </MobileNavProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
