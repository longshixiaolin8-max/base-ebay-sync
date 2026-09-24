"use client";

import { useMobileNav } from "@/components/MobileNav";

/** Only rendered while the drawer is open, so it never intercepts taps on desktop or
 *  when closed -- tapping it is the same "close" affordance as tapping a nav link. */
export function SidebarBackdrop() {
  const { open, close } = useMobileNav();
  if (!open) return null;
  return <div className="sidebar-backdrop" onClick={close} />;
}
