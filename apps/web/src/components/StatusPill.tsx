import type { Pill } from "@/lib/status";
import { TrendArrow } from "./TrendArrow";

const TONE = {
  up: "border-up/40 bg-up/5",
  down: "border-down/50 bg-down/5",
  warn: "border-warn/50 bg-warn/5",
  idle: "border-line bg-panel",
} as const;

const TEXT = { up: "text-up", down: "text-down", warn: "text-warn", idle: "text-muted" } as const;

type Props = { name: string; pill: Pill; sub?: string; tooltip?: string };

export function StatusPill({ name, pill, sub, tooltip }: Props) {
  return (
    <li title={tooltip} className={`rounded-xl border px-3 py-2.5 shadow-sm transition-colors ${TONE[pill.tone]}`}>
      <div className="text-base font-bold text-text">{name}</div>
      <div className={`mt-0.5 flex items-center gap-1.5 text-sm font-bold ${TEXT[pill.tone]}`}>
        <TrendArrow tone={pill.tone} />
        <span>{pill.label}</span>
      </div>
      {sub && <div className="num mt-0.5 text-xs font-medium text-muted">{sub}</div>}
    </li>
  );
}
