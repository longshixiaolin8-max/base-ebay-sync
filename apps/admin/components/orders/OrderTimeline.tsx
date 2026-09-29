import { buildOrderTimeline } from "@/lib/order-timeline";
import type { OrderRow } from "./types";

export function OrderTimeline({ order }: { order: OrderRow }) {
  const steps = buildOrderTimeline(order);

  return (
    <ul className="order-timeline">
      {steps.map((step, i) => (
        <li key={`${step.status}-${i}`} className="order-timeline-item" data-pending={step.timestamp === null}>
          <span className="order-timeline-dot" />
          <div>
            <div className="order-timeline-label">{step.label}</div>
            <div className="order-timeline-time">{step.timestamp ? new Date(step.timestamp).toLocaleString("ja-JP") : "未完了"}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
