"use client";

import { useRef } from "react";

interface OtpInputProps {
  length?: number;
  value: string;
  onChange: (value: string) => void;
  onComplete?: (value: string) => void;
  disabled?: boolean;
}

/**
 * Six separate digit boxes for entering a one-time code, with auto-advance on input,
 * backspace-to-previous, and paste-the-whole-code-into-one-box support -- replaces a
 * single free-text input for the TOTP/password-reset code screens.
 */
export function OtpInput({ length = 6, value, onChange, onComplete, disabled }: OtpInputProps) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  function commit(next: string) {
    const truncated = next.slice(0, length);
    onChange(truncated);
    if (truncated.length === length && /^\d+$/.test(truncated)) {
      onComplete?.(truncated);
    }
  }

  function handleChange(index: number, raw: string) {
    const digits = raw.replace(/[^0-9]/g, "");
    if (!digits) {
      const chars = value.split("");
      chars[index] = "";
      commit(chars.join(""));
      return;
    }
    const chars = value.split("");
    for (let i = 0; i < digits.length && index + i < length; i++) {
      chars[index + i] = digits[i]!;
    }
    commit(chars.join(""));
    const nextFocus = Math.min(index + digits.length, length - 1);
    refs.current[nextFocus]?.focus();
  }

  function handleKeyDown(index: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  }

  return (
    <div className="otp-digit-row">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={length}
          className="otp-digit"
          value={value[i] ?? ""}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          disabled={disabled}
          autoFocus={i === 0}
        />
      ))}
    </div>
  );
}
