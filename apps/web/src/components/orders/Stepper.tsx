// The order's path through the state machine. The current step pulses; a step
// that stopped (cancelled, failed, emergency) is red with its reason underneath.

import { type Step, stepsFor, type OrderView } from "@/lib/orders";

const DOT: Record<Step["status"], string> = {
  done: "bg-up border-up text-white",
  current: "step-current bg-accent border-accent text-white",
  todo: "bg-panel border-line text-muted",
  stopped: "bg-down border-down text-white",
  emergency: "step-current bg-down border-down text-white",
};
const MARK: Record<Step["status"], string> = { done: "✓", current: "…", todo: "", stopped: "✕", emergency: "!" };
const WORD: Record<Step["status"], string> = { done: "done", current: "in progress", todo: "not yet", stopped: "stopped here", emergency: "emergency" };

export function Stepper({ order }: { order: Pick<OrderView, "state" | "direction" | "events"> }) {
  const steps = stepsFor(order);
  const problem = steps.find((s) => s.status === "stopped" || s.status === "emergency");
  const current = steps.find((s) => s.status === "current");
  return (
    <div>
      <ol className="flex items-start" aria-label="Order progress">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex flex-1 flex-col items-center text-center" aria-current={s.status === "current" ? "step" : undefined}>
            {i > 0 && (
              <span aria-hidden="true" className="absolute top-3.5 right-1/2 h-[3px] w-full -translate-y-1/2 bg-line">
                <span className={`step-line block h-full ${s.status === "todo" ? "w-0" : "w-full"} ${s.status === "stopped" || s.status === "emergency" ? "bg-down" : "bg-up"}`} />
              </span>
            )}
            <span className={`relative z-10 flex h-7 w-7 items-center justify-center rounded-full border-2 text-sm font-black ${DOT[s.status]}`}>
              <span aria-hidden="true">{MARK[s.status]}</span>
              <span className="sr-only">{WORD[s.status]}</span>
            </span>
            <span className={`mt-1 px-1 text-xs font-bold leading-tight ${s.status === "todo" ? "text-muted" : s.status === "stopped" || s.status === "emergency" ? "text-down" : "text-text"}`}>
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      {(problem ?? current)?.detail && (
        <p className={`mt-3 rounded-lg px-3 py-2 text-sm font-semibold ${problem ? "bg-down/10 text-down" : "bg-ink text-muted"}`}>
          {(problem ?? current)!.detail}
        </p>
      )}
    </div>
  );
}
