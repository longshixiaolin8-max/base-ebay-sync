import type { CSSProperties, ReactNode } from "react";

/** Thin wrapper around the existing `.card`/`.card-pad` classes (globals.css) -- exists so
 *  new dashboard sections don't each re-type the same two class names. */
export function Card({ children, style, className }: { children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div className={`card card-pad${className ? ` ${className}` : ""}`} style={style}>
      {children}
    </div>
  );
}
