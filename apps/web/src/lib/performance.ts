// Types and pure helpers for the Performance page (unit-tested, no React here).

export type Performance = {
  curve: { t: number; equity: number; drawdownPct: number }[];
  daily: { day: string; pnl: number; pnlPct: number }[];
  windows: { days: number; actualDays: number; from: string | null; returnPct: number | null; btcPct: number | null }[];
  summary: { startEquity: number | null; equity: number | null; totalReturnPct: number | null; maxDrawdownPct: number; trades: number; wins: number; fees: number; realisedPnl: number };
};

export type CalendarCell = { day: string; pnl: number | null; pnlPct: number | null; level: -3 | -2 | -1 | 0 | 1 | 2 | 3 | null };

/** Colour step for a day's P&L %: 0 is flat, ±1 to ±3 by size (0.25%, 1%, 2%). */
export function heatLevel(pct: number | null): CalendarCell["level"] {
  if (pct === null) return null;
  const a = Math.abs(pct);
  const step = a < 0.05 ? 0 : a < 0.25 ? 1 : a < 1 ? 2 : 3;
  return (pct < 0 ? -step : step) as CalendarCell["level"];
}

/** Weeks (Monday first) covering the days with data, so the grid lines up like a calendar. */
export function calendarWeeks(daily: Performance["daily"]): CalendarCell[][] {
  if (daily.length === 0) return [];
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const DAY = 86_400_000;
  const first = Date.parse(`${daily[0]!.day}T00:00:00Z`);
  const last = Date.parse(`${daily.at(-1)!.day}T00:00:00Z`);
  const start = first - ((new Date(first).getUTCDay() + 6) % 7) * DAY; // back to Monday
  const weeks: CalendarCell[][] = [];
  for (let t = start; t <= last; t += 7 * DAY) {
    weeks.push(
      Array.from({ length: 7 }, (_, i) => {
        const day = new Date(t + i * DAY).toISOString().slice(0, 10);
        const d = byDay.get(day);
        return { day, pnl: d?.pnl ?? null, pnlPct: d?.pnlPct ?? null, level: heatLevel(d?.pnlPct ?? null) };
      }),
    );
  }
  return weeks;
}

/** "+2.4%" / "−1.0%" / "n/a". */
export function pct(v: number | null, digits = 1): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}%`;
}

/** The plain sentence under the returns table: honest about short histories and about BTC. */
export function windowNote(w: Performance["windows"][number]): string {
  if (w.returnPct === null) return "No equity recorded yet.";
  const span = w.actualDays < w.days - 0.5 ? `Only ${w.actualDays} days of history so far.` : "";
  if (w.btcPct === null) return `${span} No BTC price history for the start date, so no comparison.`.trim();
  const diff = w.returnPct - w.btcPct;
  const pts = `${Math.abs(diff).toFixed(1)} percentage points`;
  return `${span} ${Math.abs(diff) < 0.05 ? "The same as" : diff > 0 ? `${pts} ahead of` : `${pts} behind`} simply holding BTC.`.trim();
}
