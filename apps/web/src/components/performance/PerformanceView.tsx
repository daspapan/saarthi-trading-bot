"use client";

// Performance: equity curve, drawdown, returns vs holding BTC, and a calendar of daily P&L.
import useSWR from "swr";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fetcher } from "@/lib/api";
import { type Performance, calendarWeeks, pct, windowNote } from "@/lib/performance";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { NumberTicker } from "../NumberTicker";
import { Term } from "../Term";

const AXIS = { fontSize: 14, fontWeight: 600, fill: "var(--color-muted)" };
const HEAT: Record<string, string> = {
  "-3": "bg-down", "-2": "bg-down/60", "-1": "bg-down/30", "0": "bg-line", "1": "bg-up/30", "2": "bg-up/60", "3": "bg-up",
};
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function Stat({ label, children, tone }: { label: React.ReactNode; children: React.ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="text-sm font-black uppercase tracking-wide text-muted">{label}</div>
      <div className={`mt-1 text-2xl font-black ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>{children}</div>
    </div>
  );
}

export function PerformanceView() {
  const { data, error } = useSWR<Performance>("/backend/performance", fetcher, { refreshInterval: 30_000 });
  const animate = !useReducedMotion();
  if (error) return <p role="alert" className="font-bold text-down">Could not reach the API.</p>;
  if (!data) return <div className="h-96 animate-pulse rounded-2xl border border-line bg-panel" />;
  const s = data.summary;
  if (s.equity === null) {
    return <p className="rounded-2xl border border-dashed border-line bg-panel p-6 font-semibold text-muted">No equity recorded yet. The executor records it every 10 seconds once it is running and the feed has prices.</p>;
  }
  const weeks = calendarWeeks(data.daily);
  const tone = (v: number | null) => (v === null || Math.abs(v) < 0.005 ? undefined : v > 0 ? "up" : "down");
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={<Term t="equity">Equity</Term>}><NumberTicker value={s.equity} format={money} /> <span className="text-base text-muted">USDT</span></Stat>
        <Stat label="Return since start" tone={tone(s.totalReturnPct)}>{pct(s.totalReturnPct, 2)}</Stat>
        <Stat label={<Term t="drawdown">Max drawdown</Term>} tone={s.maxDrawdownPct > 0.005 ? "down" : undefined}>{s.maxDrawdownPct > 0 ? `−${s.maxDrawdownPct.toFixed(2)}%` : "0.00%"}</Stat>
        <Stat label="Trades (after fees)" tone={tone(s.realisedPnl)}>
          {s.trades} <span className="text-base text-muted">· {s.wins} won · {s.realisedPnl >= 0 ? "+" : "−"}{money(Math.abs(s.realisedPnl))} · fees {money(s.fees)}</span>
        </Stat>
      </div>

      <section aria-labelledby="eq" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 id="eq" className="mb-2 text-lg font-black">Equity</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.curve} margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--color-line)" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} tick={AXIS} />
              <YAxis domain={["auto", "auto"]} tick={AXIS} width={80} tickFormatter={(v) => Math.round(v).toLocaleString("en-US")} />
              <Tooltip labelFormatter={(t) => when(Number(t))} formatter={(v) => [`${money(Number(v))} USDT`, "Equity"]} contentStyle={{ background: "var(--color-panel)", border: "1px solid var(--color-line)" }} />
              <Line dataKey="equity" stroke="var(--color-accent)" strokeWidth={3} dot={false} isAnimationActive={animate} animationDuration={1400} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <h3 className="mt-4 mb-2 font-black"><Term t="drawdown">Drawdown</Term> from the <Term t="high-water mark">high</Term></h3>
        <div className="h-40">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.curve.map((p) => ({ t: p.t, dd: -p.drawdownPct }))} margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
              <CartesianGrid stroke="var(--color-line)" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(t) => new Date(t).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} tick={AXIS} />
              <YAxis tick={AXIS} width={80} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} />
              <Tooltip labelFormatter={(t) => when(Number(t))} formatter={(v) => [`${Number(v).toFixed(2)}%`, "Drawdown"]} contentStyle={{ background: "var(--color-panel)", border: "1px solid var(--color-line)" }} />
              <Area dataKey="dd" stroke="var(--color-down)" fill="var(--color-down)" fillOpacity={0.15} strokeWidth={2} isAnimationActive={animate} animationDuration={1400} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section aria-labelledby="ret" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 id="ret" className="mb-3 text-lg font-black">Returns vs simply holding BTC</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr><th className="py-2 pr-4 font-black">Period</th><th className="py-2 pr-4 font-black">Saarthi, after fees</th><th className="py-2 pr-4 font-black">BTC buy and hold</th><th className="py-2 font-black">In plain words</th></tr>
            </thead>
            <tbody>
              {data.windows.map((w) => (
                <tr key={w.days} className="border-t border-line">
                  <td className="py-2.5 pr-4 font-bold">{w.days} days</td>
                  <td className={`num py-2.5 pr-4 text-lg font-black ${tone(w.returnPct) === "up" ? "text-up" : tone(w.returnPct) === "down" ? "text-down" : ""}`}>{pct(w.returnPct, 2)}</td>
                  <td className="num py-2.5 pr-4 text-lg font-bold">{pct(w.btcPct, 2)}</td>
                  <td className="py-2.5 text-sm font-semibold text-muted">{windowNote(w)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm font-semibold text-muted">Testnet results with virtual money. They do not predict real results.</p>
      </section>

      <section aria-labelledby="cal" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
        <h2 id="cal" className="mb-3 text-lg font-black">Daily P&amp;L (UTC days, after fees)</h2>
        <div className="overflow-x-auto">
          <table className="border-separate border-spacing-1">
            <thead>
              <tr>{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <th key={d} className="text-xs font-black text-muted">{d}</th>)}</tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr key={w[0]!.day}>
                  {w.map((c) => (
                    <td key={c.day} title={c.pnl === null ? `${c.day}: no data` : `${c.day}: ${c.pnl >= 0 ? "+" : "−"}${money(Math.abs(c.pnl))} USDT (${pct(c.pnlPct, 2)})`}>
                      <div className={`slide-in grid h-12 w-14 place-items-center rounded-md text-xs font-black ${c.level === null ? "border border-dashed border-line text-muted" : `${HEAT[String(c.level)]} ${Math.abs(c.level) >= 2 ? "text-white" : "text-text"}`}`}>
                        <span className="num">{c.day.slice(8)}</span>
                        <span className="sr-only">{c.pnl === null ? "no data" : pct(c.pnlPct, 2)}</span>
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-sm font-semibold text-muted">Green is a gain, red a loss; darker is bigger. Hover or focus a day for the amount.</p>
      </section>
    </div>
  );
}
