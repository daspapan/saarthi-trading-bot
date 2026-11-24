"use client";

// One backtest's results: headline numbers, equity vs buy-and-hold, drawdown,
// the walk-forward check and the trade log. Fees and slippage are always shown.
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  EXIT_LABELS,
  type Metrics,
  type Run,
  STRATEGY_NAMES,
  fmtDate,
  fmtHours,
  fmtPct,
  fmtPlainPct,
  fmtRatio,
  fmtUsd,
  toneOf,
} from "@/lib/backtest";
import { formatPrice } from "@/lib/status";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { TrendArrow } from "../TrendArrow";

const AXIS = { fontSize: 14, fontWeight: 600, fill: "#334155" };
const shortDate = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

function Stat({ label, value, tone, help, sub }: { label: string; value: string; tone?: "up" | "down" | "flat"; help: string; sub?: string }) {
  const color = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text";
  return (
    <div title={help} className="rounded-xl border border-line bg-panel px-3 py-2.5">
      <div className="text-xs font-bold uppercase tracking-wide text-muted">{label}</div>
      <div className={`num mt-0.5 flex items-center gap-1 text-2xl font-black ${color}`}>
        {tone && tone !== "flat" && <TrendArrow tone={tone} size={20} />}
        {value}
      </div>
      {sub && <div className="text-xs font-semibold text-muted">{sub}</div>}
    </div>
  );
}

function MetricGrid({ m, benchmark }: { m: Metrics; benchmark?: Run["benchmark"] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <Stat
        label="Total return"
        value={fmtPct(m.totalReturn)}
        tone={toneOf(m.totalReturn)}
        sub={benchmark ? `BTC buy & hold ${fmtPct(benchmark.totalReturn)}` : undefined}
        help="End equity divided by start equity, after fees and slippage."
      />
      <Stat label="CAGR" value={fmtPct(m.cagr)} help="The yearly growth rate that would give this total return." />
      <Stat label="Max drawdown" value={fmtPlainPct(m.maxDrawdown)} tone={m.maxDrawdown > 0 ? "down" : "flat"} help="The largest fall from a peak, as a share of that peak." />
      <Stat label="Sharpe" value={fmtRatio(m.sharpe)} help="Average daily return divided by its ups and downs, scaled to a year. Higher is steadier." />
      <Stat label="Sortino" value={fmtRatio(m.sortino)} help="Like Sharpe, but only counts the downside swings." />
      <Stat label="Win rate" value={fmtPlainPct(m.winRate, 0)} sub={`${m.trades} trades`} help="Share of trades that made money after fees." />
      <Stat label="Profit factor" value={fmtRatio(m.profitFactor)} help="Money made on winners divided by money lost on losers. Above 1 means winners outweigh losers." />
      <Stat label="Avg trade" value={fmtHours(m.avgTradeDurationHours)} sub={`in the market ${fmtPlainPct(m.exposure, 0)} of the time`} help="How long a trade lasted on average, and the share of time any position was open." />
    </div>
  );
}

function EquityChart({ run, animate }: { run: Run; animate: boolean }) {
  const bench = run.benchmark?.curve ?? [];
  const data = (run.curve ?? []).map((p, i) => ({ time: p.time, strategy: p.equity, benchmark: bench[i]?.equity ?? null }));
  return (
    <figure className="rounded-2xl border border-line bg-panel p-4">
      <figcaption className="mb-2 text-base font-black">Equity: strategy vs {run.benchmark?.pair ?? "BTC"} buy &amp; hold (USDT)</figcaption>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#e2e8f0" />
            <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={AXIS} minTickGap={40} />
            <YAxis tick={AXIS} width={70} tickFormatter={(v) => Math.round(v).toLocaleString("en-US")} domain={["auto", "auto"]} />
            <Tooltip labelFormatter={(v) => fmtDate(Number(v))} formatter={(v) => fmtUsd(Number(v))} />
            <Legend wrapperStyle={{ fontWeight: 700 }} />
            <Line name="Strategy" dataKey="strategy" stroke="#0369a1" strokeWidth={3} dot={false} isAnimationActive={animate} animationDuration={1600} />
            <Line name="Buy & hold" dataKey="benchmark" stroke="#64748b" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={animate} animationDuration={1600} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function DrawdownChart({ run, animate }: { run: Run; animate: boolean }) {
  const data = (run.drawdown ?? []).map((p) => ({ time: p.time, dd: p.equity * 100 }));
  return (
    <figure className="rounded-2xl border border-line bg-panel p-4">
      <figcaption className="mb-2 text-base font-black">Drawdown: how far below the last peak (%)</figcaption>
      <div className="h-40">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#e2e8f0" />
            <XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={AXIS} minTickGap={40} />
            <YAxis tick={AXIS} width={70} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
            <Tooltip labelFormatter={(v) => fmtDate(Number(v))} formatter={(v) => `${Number(v).toFixed(2)}%`} />
            <Area dataKey="dd" name="Drawdown" stroke="#be123c" fill="#be123c" fillOpacity={0.15} strokeWidth={2} isAnimationActive={animate} animationDuration={1600} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function WalkForwardPanel({ wf }: { wf: NonNullable<Run["walkForward"]> }) {
  const rows: [string, (m: Metrics) => string][] = [
    ["Return", (m) => fmtPct(m.totalReturn)],
    ["CAGR", (m) => fmtPct(m.cagr)],
    ["Sharpe", (m) => fmtRatio(m.sharpe)],
    ["Max drawdown", (m) => fmtPlainPct(m.maxDrawdown)],
    ["Trades", (m) => String(m.trades)],
  ];
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h3 className="text-base font-black">Walk-forward check</h3>
      <p className="text-sm font-medium text-muted">
        The same settings on the first 70% and the last 30% of the period (split on {fmtDate(wf.splitTime)}). Similar
        numbers suggest a real pattern; very different numbers suggest luck.
      </p>
      <table className="num mt-2 w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 font-bold" />
            <th className="py-1 text-right font-bold">In-sample (70%)</th>
            <th className="py-1 text-right font-bold">Out-of-sample (30%)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, f]) => (
            <tr key={name} className="border-t border-line">
              <td className="py-1 font-semibold">{name}</td>
              <td className="py-1 text-right font-bold">{f(wf.inSample)}</td>
              <td className="py-1 text-right font-bold">{f(wf.outOfSample)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {wf.warning ? (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg border border-warn/50 bg-warn/5 px-3 py-2 text-sm font-bold text-warn">
          <TrendArrow tone="warn" /> {wf.warning}
        </p>
      ) : wf.inSample.cagr < 0 && wf.outOfSample.cagr < 0 ? (
        <p className="mt-3 flex gap-2 rounded-lg border border-down/40 bg-down/5 px-3 py-2 text-sm font-bold text-down">
          <TrendArrow tone="down" /> Both periods lose money. The result is consistent, but consistently negative: no edge after costs.
        </p>
      ) : (
        <p className="mt-3 text-sm font-bold text-up">The two periods broadly agree.</p>
      )}
    </section>
  );
}

function TradeTable({ run }: { run: Run }) {
  if (!run.trades.length) return <p className="text-sm font-medium text-muted">No trades in this period.</p>;
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h3 className="text-base font-black">
        Trade log <span className="text-sm font-semibold text-muted">({run.totalTrades} trades{run.totalTrades > run.trades.length ? `, latest ${run.trades.length} shown` : ""})</span>
      </h3>
      <div className="mt-2 max-h-96 overflow-auto">
        <table className="num w-full text-sm">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-left text-muted">
              {["Entry", "Pair", "Strategy", "Entry price", "Exit price", "Fees", "P&L (after fees)", "Exit"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1 font-bold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.trades.map((t) => (
              <tr key={`${t.candidateId}-${t.entryTime}`} className="border-t border-line">
                <td className="whitespace-nowrap px-2 py-1">{new Date(t.entryTime).toISOString().slice(0, 16).replace("T", " ")}</td>
                <td className="px-2 py-1 font-semibold">{t.pair}</td>
                <td className="whitespace-nowrap px-2 py-1">{STRATEGY_NAMES[t.strategy] ?? t.strategy}</td>
                <td className="px-2 py-1 text-right">{formatPrice(t.entryPrice)}</td>
                <td className="px-2 py-1 text-right">{formatPrice(t.exitPrice)}</td>
                <td className="px-2 py-1 text-right">{fmtUsd(t.fees)}</td>
                <td className={`px-2 py-1 text-right font-bold ${t.pnl > 0 ? "text-up" : "text-down"}`}>{fmtUsd(t.pnl)}</td>
                <td className="whitespace-nowrap px-2 py-1">{EXIT_LABELS[t.exitReason] ?? t.exitReason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function RunResult({ run }: { run: Run }) {
  const reduced = useReducedMotion();

  if (run.status === "running") {
    return (
      <section aria-busy="true" className="rounded-2xl border border-accent/40 bg-accent/5 p-6">
        <div className="flex items-center gap-3">
          <span className="h-5 w-5 animate-spin rounded-full border-[3px] border-accent border-t-transparent" />
          <p className="text-lg font-black text-accent">Running backtest #{run.id}…</p>
        </div>
        <p className="mt-1 text-sm font-medium text-muted">
          Replaying every 15-minute candle through the strategies, position sizing and risk rules, then splitting the
          period for the walk-forward check.
        </p>
      </section>
    );
  }

  if (run.status === "failed" || !run.metrics) {
    return (
      <section role="alert" className="rounded-2xl border border-down/50 bg-down/5 p-6">
        <p className="text-lg font-black text-down">Backtest #{run.id} failed</p>
        <p className="text-sm font-semibold text-text">{run.error}</p>
      </section>
    );
  }

  const costs = run.costs ?? { feeBps: 10, slippageBps: run.params.slippageBps };
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-x-3">
        <h2 className="text-2xl font-black">
          #{run.id} {run.label ?? STRATEGY_NAMES[run.strategy] ?? run.strategy}
        </h2>
        <p className="text-sm font-semibold text-muted">
          {STRATEGY_NAMES[run.strategy]} · {fmtDate(run.from)} to {fmtDate(run.to)} · {run.metrics.days.toFixed(0)} days · start{" "}
          {fmtUsd(run.metrics.startEquity)}
        </p>
      </header>

      <p className="rounded-lg border border-line bg-ink px-3 py-2 text-sm font-semibold text-text">
        Includes a {(costs.feeBps / 100).toFixed(2)}% fee and {costs.slippageBps} bps slippage on every fill: {fmtUsd(run.metrics.totalFees)} in
        fees and about {fmtUsd(run.metrics.totalSlippage)} lost to slippage. Past results do not predict future results.
      </p>

      <MetricGrid m={run.metrics} benchmark={run.benchmark} />
      <EquityChart run={run} animate={!reduced} />
      <DrawdownChart run={run} animate={!reduced} />
      {run.walkForward && <WalkForwardPanel wf={run.walkForward} />}

      {!!run.events?.length && (
        <section className="rounded-2xl border border-warn/50 bg-warn/5 p-4">
          <h3 className="text-base font-black text-warn">Risk controls that fired</h3>
          <ul className="mt-1 space-y-1 text-sm font-semibold">
            {run.events.slice(0, 8).map((e) => (
              <li key={`${e.kind}-${e.time}`}>
                <span className="num text-muted">{new Date(e.time).toISOString().slice(0, 16).replace("T", " ")}</span> {e.message}
              </li>
            ))}
            {run.events.length > 8 && <li className="text-muted">…and {run.events.length - 8} more.</li>}
          </ul>
        </section>
      )}

      <TradeTable run={run} />
    </div>
  );
}
