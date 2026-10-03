/** Generic on/off switch -- same visual language as ThemeToggle's `.theme-switch`, but that
 *  component is theme-specific, so this reuses the same look under a neutral class name for
 *  any other boolean setting (currently: 通知設定 tab's 5 toggles). */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="theme-switch"
      data-on={checked}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
    />
  );
}
