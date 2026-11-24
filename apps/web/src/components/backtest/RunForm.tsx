"use client";

// The "set up a run" form. Parameter inputs show each setting's approved range,
// and the API refuses anything outside it anyway.
import { useEffect, useState } from "react";
import { STRATEGY_NAMES, fmtDate, fromDateInput, toDateInput } from "@/lib/backtest";

type NumberSetting = { value: number; min: number; max: number; help: string };
type Settings = { strategy: Record<string, NumberSetting>; risk: Record<string, NumberSetting> };
type DataInfo = { range: { from: number; to: number } | null; hint: string | null };

const PARAMS: Record<string, string[]> = {
  statArb: ["statArb.zEntry", "statArb.zExit"],
  momentum: ["momentum.minVolumeRatio", "momentum.targetR"],
  meanReversion: ["meanReversion.rsiEntry", "meanReversion.maxBandWidthPct"],
};

const LABELS: Record<string, string> = {
  "statArb.zEntry": "Stat-arb: entry z-score",
  "statArb.zExit": "Stat-arb: exit z-score",
  "momentum.minVolumeRatio": "Momentum: min volume vs average",
  "momentum.targetR": "Momentum: target (× stop distance)",
  "meanReversion.rsiEntry": "Mean reversion: RSI at or below",
  "meanReversion.maxBandWidthPct": "Mean reversion: max band width %",
  riskPerTradeBps: "Risk per trade (bps of equity)",
};

type Props = {
  data: DataInfo;
  settings: Settings;
  busy: boolean;
  onStarted: (id: number) => void;
};

export function RunForm({ data, settings, busy, onStarted }: Props) {
  const [strategy, setStrategy] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [slippage, setSlippage] = useState(5);
  const [label, setLabel] = useState("");
  const [params, setParams] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Default the dates to everything that's been downloaded.
  useEffect(() => {
    if (data.range && !from) {
      setFrom(toDateInput(data.range.from));
      setTo(toDateInput(data.range.to));
    }
  }, [data.range, from]);

  const keys = ["riskPerTradeBps", ...(strategy === "all" ? Object.values(PARAMS).flat() : PARAMS[strategy] ?? [])];
  const settingFor = (k: string) => settings.strategy[k] ?? settings.risk[k];

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fromMs = fromDateInput(from);
    const toMs = fromDateInput(to);
    if (fromMs === null || toMs === null) return setError("Pick a start and end date.");
    // Send only the values you changed.
    const overrides = Object.fromEntries(Object.entries(params).filter(([k, v]) => keys.includes(k) && v !== settingFor(k)?.value));
    setSending(true);
    try {
      const res = await fetch("/backend/backtests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategy, from: fromMs, to: toMs + 86_400_000, slippageBps: slippage, overrides, label: label || undefined }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? "The API refused the run.");
      else onStarted(body.id);
    } catch {
      setError("Could not reach the API.");
    } finally {
      setSending(false);
    }
  }

  if (!data.range) {
    return (
      <section className="rounded-2xl border border-dashed border-line bg-panel p-6">
        <h2 className="text-lg font-black">No history downloaded yet</h2>
        <p className="mt-1 text-sm font-medium text-muted">{data.hint}</p>
        <pre className="num mt-3 rounded-lg bg-ink px-3 py-2 text-sm font-semibold">npm run candles:download</pre>
      </section>
    );
  }

  // Numbers use the tabular font; words (dropdown, name) use the normal one.
  const field = "mt-1 w-full rounded-lg border border-line bg-panel px-3 py-2 text-base font-semibold";
  const numField = `num ${field}`;
  return (
    <form onSubmit={run} className="space-y-4 rounded-2xl border border-line bg-panel p-4 shadow-sm" aria-label="Set up a backtest">
      <h2 className="text-lg font-black">Set up a run</h2>

      <label className="block text-sm font-bold">
        Strategy
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)} className={field}>
          {Object.entries(STRATEGY_NAMES).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 gap-3">
        <label className="block text-sm font-bold">
          From
          <input type="date" value={from} min={toDateInput(data.range.from)} max={to} onChange={(e) => setFrom(e.target.value)} className={numField} />
        </label>
        <label className="block text-sm font-bold">
          To
          <input type="date" value={to} min={from} max={toDateInput(data.range.to)} onChange={(e) => setTo(e.target.value)} className={numField} />
        </label>
      </div>
      <p className="text-xs font-medium text-muted">
        Data on disk: {fmtDate(data.range.from)} to {fmtDate(data.range.to)}
      </p>

      <label className="block text-sm font-bold" title="How much worse than the candle price each fill is assumed to be. 5 bps = 0.05%.">
        Slippage per fill (bps)
        <input type="number" min={0} max={50} step={1} value={slippage} onChange={(e) => setSlippage(Number(e.target.value))} className={numField} />
        <span className="text-xs font-medium text-muted">Plus the 0.1% exchange fee on every fill. Allowed 0 to 50.</span>
      </label>

      <fieldset className="space-y-3">
        <legend className="text-sm font-bold">Parameters (within approved ranges)</legend>
        {keys.map((k) => {
          const s = settingFor(k);
          if (!s) return null;
          return (
            <label key={k} className="block text-sm font-semibold" title={s.help}>
              {LABELS[k] ?? k}
              <input
                type="number"
                min={s.min}
                max={s.max}
                step="any"
                value={params[k] ?? s.value}
                onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })}
                className={numField}
              />
              <span className="text-xs font-medium text-muted">
                default {s.value}, allowed {s.min} to {s.max}
              </span>
            </label>
          );
        })}
      </fieldset>

      <label className="block text-sm font-bold">
        Name this run (optional)
        <input type="text" maxLength={60} value={label} placeholder="e.g. baseline" onChange={(e) => setLabel(e.target.value)} className={field} />
      </label>

      {error && (
        <p role="alert" className="rounded-lg border border-down/40 bg-down/5 px-3 py-2 text-sm font-semibold text-down">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || sending}
        className="w-full rounded-xl bg-accent px-4 py-3 text-base font-black text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "A backtest is running…" : sending ? "Starting…" : "Run backtest"}
      </button>
    </form>
  );
}
