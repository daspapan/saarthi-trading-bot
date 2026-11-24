"use client";

// One AI signal: what it said, the evidence check ("AI said" vs "snapshot"),
// the candidate it chose (numbers computed by code), and the guardrail verdict.
import { type SignalCard, directionBadge, showValue } from "@/lib/analyst";
import { formatPrice } from "@/lib/status";
import { TrendArrow } from "../TrendArrow";

const TONE_TEXT = { up: "text-up border-up/40 bg-up/5", down: "text-down border-down/40 bg-down/5", warn: "text-warn border-warn/40 bg-warn/5", idle: "text-muted border-line bg-ink" } as const;

function Evidence({ rows }: { rows: SignalCard["evidence"] }) {
  if (!rows.length) return null;
  return (
    <table className="num mt-3 w-full text-sm">
      <thead>
        <tr className="text-left text-muted">
          <th className="py-1 font-bold">Data point</th>
          <th className="py-1 text-right font-bold">AI said</th>
          <th className="py-1 text-right font-bold">Snapshot</th>
          <th className="w-24 py-1 text-right font-bold">Check</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          // Rows tick in one after another, so the check reads like it's happening.
          <tr key={`${r.name}-${i}`} className="evidence-row border-t border-line" style={{ animationDelay: `${150 + i * 180}ms` }}>
            <td className="py-1 pr-2 font-sans font-semibold">{r.name}</td>
            <td className={`py-1 text-right font-bold ${r.match ? "" : "text-down"}`}>{showValue(r.aiValue)}</td>
            <td className="py-1 text-right font-bold">{r.snapshotValue ?? "not in snapshot"}</td>
            <td className={`py-1 text-right font-black ${r.match ? "text-up" : "text-down"}`}>
              <span className="evidence-tick inline-flex items-center gap-1" style={{ animationDelay: `${150 + i * 180}ms` }}>
                {r.match ? "✓ match" : "✗ differs"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CandidateBox({ c }: { c: NonNullable<SignalCard["candidate"]> }) {
  const cells: [string, string, string][] =
    c.direction === "long"
      ? [
          ["Entry", formatPrice(c.entry), "Limit buy price, computed by code."],
          ["Stop", formatPrice(c.stop), "Protective stop, from ATR."],
          ["Target", formatPrice(c.target), "Take-profit, from the strategy."],
          ["Reward : risk", `${c.rewardToRisk.toFixed(2)} : 1`, "Distance to target divided by distance to stop."],
          ["Size", `${c.notional.toLocaleString("en-US")} USDT`, "Order value, capped by the risk limits."],
          ["At risk", `${c.riskAmount.toLocaleString("en-US")} USDT`, "Loss if the stop is hit (before fees)."],
        ]
      : [
          ["Sell at", formatPrice(c.price), "Market price now."],
          ["Quantity", String(c.quantity), "Everything stat-arb bought."],
        ];
  return (
    <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-accent">Candidate chosen (numbers computed by code, not the AI)</p>
      <p className="num mt-0.5 break-all text-xs font-semibold text-muted">{c.id}</p>
      <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
        {cells.map(([k, v, help]) => (
          <div key={k} title={help}>
            <dt className="text-xs font-bold text-muted">{k}</dt>
            <dd className="font-black">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function SignalCardView({ s }: { s: SignalCard }) {
  const badge = directionBadge(s.direction);
  const system = s.source !== "ollama";
  return (
    <article className={`slide-in rounded-2xl border bg-panel p-4 shadow-sm ${s.guardrails.passed ? "border-line" : "border-down/50"}`}>
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-black">{s.pair}</h3>
        <span title={badge.help} className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-sm font-black ${TONE_TEXT[badge.tone]}`}>
          <TrendArrow tone={badge.tone === "idle" ? "flat" : badge.tone} size={16} />
          {badge.label}
        </span>
        {s.confidence && (
          <span className="rounded-md border border-line px-2 py-0.5 text-sm font-bold text-muted" title="How sure the AI says it is. Low confidence is logged only.">
            confidence: {s.confidence}
          </span>
        )}
        <span
          className={`ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-sm font-black ${
            s.guardrails.passed ? "bg-up/10 text-up" : "bg-down/10 text-down"
          }`}
        >
          {s.guardrails.passed ? "✓ Passed guardrails" : "✗ Rejected by guardrails"}
        </span>
      </header>

      {system && s.note && <p className="mt-2 text-sm font-semibold text-muted">{s.note}</p>}

      {s.rationale && <p className="mt-2 text-base font-medium leading-relaxed text-text">“{s.rationale}”</p>}
      {(s.triggerText || s.invalidation) && (
        <dl className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
          {s.triggerText && (
            <div>
              <dt className="text-xs font-bold uppercase text-muted">Trigger</dt>
              <dd className="font-semibold">{s.triggerText}</dd>
            </div>
          )}
          {s.invalidation && (
            <div>
              <dt className="text-xs font-bold uppercase text-muted">Invalidated if</dt>
              <dd className="font-semibold">{s.invalidation}</dd>
            </div>
          )}
        </dl>
      )}

      {s.candidate && <CandidateBox c={s.candidate} />}
      <Evidence rows={s.evidence} />

      {!s.guardrails.passed && (
        <div role="alert" className="mt-3 rounded-xl border border-down/40 bg-down/5 p-3">
          <p className="text-sm font-black text-down">Why it was rejected</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm font-semibold text-text">
            {s.guardrails.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      <footer className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-dashed border-line px-3 py-2">
          <p className="text-xs font-bold uppercase text-muted">Validator rules</p>
          <p className="font-semibold text-muted">{s.guardrails.passed && s.direction !== "neutral" ? "The 12 deterministic risk rules run here from phase 5." : "Not sent to the validator."}</p>
        </div>
        <div className="rounded-lg border border-dashed border-line px-3 py-2">
          <p className="text-xs font-bold uppercase text-muted">What happened next</p>
          <p className="font-semibold text-muted">No order: orders start in phase 6.</p>
        </div>
      </footer>
    </article>
  );
}
