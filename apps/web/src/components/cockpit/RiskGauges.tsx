// Three half-circle gauges: daily loss used, drawdown, exposure. Each fills toward
// its own limit and carries a word (OK / WARNING / LIMIT), never colour alone.

import type { Gauge } from "@/lib/risk";

const COLOR = { ok: "var(--color-up)", warning: "var(--color-warn)", limit: "var(--color-down)" } as const;
const TEXT = { ok: "text-up", warning: "text-warn", limit: "text-down" } as const;

function Arc({ pct, level }: { pct: number; level: Gauge["level"] }) {
  const r = 52;
  const len = Math.PI * r;
  const shown = Math.min(100, Math.max(0, pct));
  return (
    <svg viewBox="0 0 120 68" className="w-full max-w-44" aria-hidden="true">
      <path d="M8 62 A52 52 0 0 1 112 62" fill="none" stroke="var(--color-line)" strokeWidth="12" strokeLinecap="round" />
      <path
        d="M8 62 A52 52 0 0 1 112 62"
        fill="none"
        stroke={COLOR[level]}
        strokeWidth="12"
        strokeLinecap="round"
        strokeDasharray={len}
        strokeDashoffset={len * (1 - shown / 100)}
        className="gauge-arc"
      />
    </svg>
  );
}

export function RiskGauges({ gauges }: { gauges: Gauge[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {gauges.map((g) => (
        <div key={g.key} className="flex flex-col items-center rounded-2xl border border-line bg-panel p-4 text-center shadow-sm" title={g.help}>
          <h3 className="text-sm font-black uppercase tracking-wide text-muted">{g.label}</h3>
          <div className="relative mt-2 w-full max-w-44">
            <Arc pct={g.usedPct} level={g.level} />
            <span className="num absolute inset-x-0 bottom-0 text-2xl font-black">{g.value}</span>
          </div>
          <span className={`mt-1 rounded-md px-2 py-0.5 text-xs font-black ${TEXT[g.level]} ${g.level === "ok" ? "bg-up/10" : g.level === "warning" ? "bg-warn/10" : "bg-down/10"}`}>
            {g.word}
          </span>
          <p className="num mt-2 text-xs font-semibold text-muted">{g.detail}</p>
          <span className="sr-only">{g.help}</span>
        </div>
      ))}
    </div>
  );
}
