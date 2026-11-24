"use client";

// The list of past runs. Tick up to three to compare their equity curves
// (as % change from their start) and their numbers side by side.
import useSWR from "swr";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Run, type RunSummary, STRATEGY_NAMES, compareRows, fmtDate, fmtPct, fmtPlainPct, fmtRatio, normalise } from "@/lib/backtest";
import { useReducedMotion } from "@/lib/useReducedMotion";

const COLORS = ["#0369a1", "#b45309", "#7c3aed"];
const AXIS = { fontSize: 14, fontWeight: 600, fill: "#334155" };

type Props = {
  runs: RunSummary[];
  selectedId: number | null;
  compareIds: number[];
  onSelect: (id: number) => void;
  onToggleCompare: (id: number) => void;
};

export function RunsTable({ runs, selectedId, compareIds, onSelect, onToggleCompare }: Props) {
  if (!runs.length) {
    return <p className="rounded-2xl border border-dashed border-line bg-panel p-4 text-sm font-medium text-muted">No runs yet. Set one up and press Run.</p>;
  }
  return (
    <section className="rounded-2xl border border-line bg-panel p-4">
      <h2 className="text-lg font-black">Past runs</h2>
      <p className="text-sm font-medium text-muted">Click a row to open it. Tick up to three to compare.</p>
      <div className="mt-2 overflow-x-auto">
        <table className="num w-full text-sm">
          <thead>
            <tr className="text-left text-muted">
              {["Compare", "#", "Name", "Period", "Return", "vs BTC", "Sharpe", "Max DD", "Trades"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1 font-bold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr
                key={r.id}
                onClick={() => onSelect(r.id)}
                className={`cursor-pointer border-t border-line hover:bg-ink ${r.id === selectedId ? "bg-accent/5" : ""}`}
              >
                <td className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    aria-label={`Compare run ${r.id}`}
                    disabled={r.status !== "done" || (!compareIds.includes(r.id) && compareIds.length >= 3)}
                    checked={compareIds.includes(r.id)}
                    onChange={() => onToggleCompare(r.id)}
                    className="h-4 w-4 accent-[#0369a1]"
                  />
                </td>
                <td className="px-2 py-1.5 font-bold">{r.id}</td>
                <td className="px-2 py-1.5 font-semibold">{r.label ?? STRATEGY_NAMES[r.strategy] ?? r.strategy}</td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  {fmtDate(r.from)} – {fmtDate(r.to)}
                </td>
                {r.summary ? (
                  <>
                    <td className={`px-2 py-1.5 font-bold ${r.summary.totalReturn > 0 ? "text-up" : "text-down"}`}>{fmtPct(r.summary.totalReturn)}</td>
                    <td className="px-2 py-1.5">{fmtPct(r.summary.benchmarkReturn)}</td>
                    <td className="px-2 py-1.5">{fmtRatio(r.summary.sharpe)}</td>
                    <td className="px-2 py-1.5">{fmtPlainPct(r.summary.maxDrawdown)}</td>
                    <td className="px-2 py-1.5">{r.summary.trades}</td>
                  </>
                ) : (
                  <td colSpan={5} className={`px-2 py-1.5 font-semibold ${r.status === "failed" ? "text-down" : "text-accent"}`}>
                    {r.status === "running" ? "Running…" : `Failed: ${r.error}`}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const fetchRuns = (ids: number[]) => Promise.all(ids.map((id) => fetch(`/backend/backtests/${id}`).then((r) => r.json() as Promise<Run>)));

export function ComparePanel({ ids }: { ids: number[] }) {
  const reduced = useReducedMotion();
  const { data } = useSWR(ids.length >= 2 ? ["compare", ...ids] : null, () => fetchRuns(ids));
  if (ids.length < 2) return null;
  if (!data) return <div className="h-80 animate-pulse rounded-2xl border border-line bg-panel" />;

  const series = data.map((r) => normalise(r.curve ?? []));
  const name = (r: Run) => `#${r.id} ${r.label ?? STRATEGY_NAMES[r.strategy] ?? r.strategy}`;
  return (
    <section className="space-y-3 rounded-2xl border border-line bg-panel p-4">
      <h2 className="text-lg font-black">Comparing {data.length} runs</h2>
      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart margin={{ top: 5, right: 12, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="#e2e8f0" />
            <XAxis
              dataKey="time"
              type="number"
              domain={["dataMin", "dataMax"]}
              allowDuplicatedCategory={false}
              tickFormatter={(ms) => new Date(ms).toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" })}
              tick={AXIS}
              minTickGap={40}
            />
            <YAxis tick={AXIS} width={60} tickFormatter={(v) => `${Number(v).toFixed(0)}%`} />
            <Tooltip labelFormatter={(v) => fmtDate(Number(v))} formatter={(v) => `${Number(v).toFixed(2)}%`} />
            <Legend wrapperStyle={{ fontWeight: 700 }} />
            {data.map((r, i) => (
              <Line
                key={r.id}
                data={series[i]}
                dataKey="pct"
                name={name(r)}
                stroke={COLORS[i]}
                strokeWidth={3}
                dot={false}
                isAnimationActive={!reduced}
                animationDuration={1600}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <table className="num w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1" />
            {data.map((r, i) => (
              <th key={r.id} className="py-1 text-right font-bold" style={{ color: COLORS[i] }}>
                {name(r)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {compareRows(data).map(([label, values]) => (
            <tr key={label} className="border-t border-line">
              <td className="py-1 font-semibold">{label}</td>
              {values.map((v, i) => (
                <td key={i} className="py-1 text-right font-bold">
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
