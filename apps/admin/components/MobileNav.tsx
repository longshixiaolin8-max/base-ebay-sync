"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

interface MobileNavContextValue {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

const MobileNavContext = createContext<MobileNavContextValue | null>(null);

/** Shared open/close state for the off-canvas sidebar drawer on mobile, mirroring
 *  ToastProvider's context+hook pattern -- Sidebar and Topbar are siblings under
 *  layout.tsx, not parent/child, so this is the shared state they both need. */
export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  const close = useCallback(() => setOpen(false), []);

  return <MobileNavContext.Provider value={{ open, toggle, close }}>{children}</MobileNavContext.Provider>;
}

export function useMobileNav(): MobileNavContextValue {
  const ctx = useContext(MobileNavContext);
  if (!ctx) {
    // Outside a MobileNavProvider (shouldn't happen in this app), degrade to an
    // always-closed no-op rather than crashing.
    return { open: false, toggle: () => {}, close: () => {} };
  }
  return ctx;
}
