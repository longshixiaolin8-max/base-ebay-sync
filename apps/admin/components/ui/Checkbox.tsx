interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** Visually hides the label (still read by screen readers) -- for a bare row-selection
   *  checkbox where the row itself already provides visible context. */
  labelHidden?: boolean;
  indeterminate?: boolean;
}

export function Checkbox({ checked, onChange, label, labelHidden, indeterminate }: CheckboxProps) {
  return (
    <label className="ui-checkbox">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        ref={(el) => {
          if (el) el.indeterminate = Boolean(indeterminate);
        }}
      />
      <span className={labelHidden ? "sr-only" : undefined}>{label}</span>
    </label>
  );
}
