"use client";

import { CheckIcon } from "@/components/icons";

export const ONBOARDING_STEPS = ["接続", "設定", "紐付け", "初回出品"];

export function OnboardingStepper({ current }: { current: number }) {
  return (
    <div className="stepper">
      {ONBOARDING_STEPS.map((label, i) => (
        <div key={label} style={{ display: "contents" }}>
          <div className="stepper-item" data-state={i < current ? "done" : i === current ? "active" : "pending"}>
            <span className="stepper-dot">{i < current ? <CheckIcon /> : i + 1}</span>
            <span className="stepper-label">{label}</span>
          </div>
          {i < ONBOARDING_STEPS.length - 1 && <div className="stepper-connector" data-done={i < current} />}
        </div>
      ))}
    </div>
  );
}
