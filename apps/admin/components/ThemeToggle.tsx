"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "admin-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Manual light/dark override on top of the OS default -- see globals.css's [data-theme]
 *  rules. Persisted per-browser only (localStorage); there's no server-side concept of a
 *  user's theme preference, matching every other per-viewer UI convenience in this app. */
export function ThemeToggle() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {
      // localStorage can throw in a private-browsing/blocked-storage context -- fall back
      // to the OS preference below rather than breaking the page.
    }
    const dark = stored === "dark" || (stored !== "light" && systemPrefersDark());
    setIsDark(dark);
    document.documentElement.setAttribute("data-theme", stored === "light" || stored === "dark" ? stored : dark ? "dark" : "light");
  }, []);

  function toggle() {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.setAttribute("data-theme", next ? "dark" : "light");
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      // Non-fatal: the toggle still works for this page load, just won't persist.
    }
  }

  return (
    <div className="sidebar-toggle-row">
      <span>ダークモード</span>
      <button
        type="button"
        className="theme-switch"
        data-on={isDark}
        onClick={toggle}
        role="switch"
        aria-checked={isDark}
        aria-label="ダークモードを切り替え"
      />
    </div>
  );
}
