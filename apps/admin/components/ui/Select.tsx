import type { ReactNode } from "react";

interface SelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
}

/** A native <select> wrapper -- deliberately not a custom listbox: native selects are free
 *  keyboard/screen-reader support, and this app's filter dropdowns have no need (multi-select,
 *  search-within, custom option rendering) that would justify giving that up. */
export function Select({ label, value, onChange, children, disabled }: SelectProps) {
  return (
    <label className="ui-select">
      <span className="ui-select-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {children}
      </select>
    </label>
  );
}
