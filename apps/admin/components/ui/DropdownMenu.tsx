"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface DropdownMenuProps {
  /** Rendered as the clickable trigger; receives no props -- wrap your own button/element. */
  trigger: ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  label: string;
}

/**
 * Minimal accessible dropdown: closes on an outside click or Escape, traps no focus (the
 * menu bodies used here -- a short list of links/buttons -- don't need arrow-key roving).
 * Used by Topbar's user menu; written generically since more menus (row actions, filters)
 * will want the same open/close/outside-click behavior as more pages get this treatment.
 */
export function DropdownMenu({ trigger, children, align = "right", label }: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="dropdown-menu-root" ref={rootRef}>
      <button
        type="button"
        className="dropdown-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div className={`dropdown-menu-panel dropdown-menu-${align}`} role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
