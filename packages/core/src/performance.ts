// The Performance page: equity and drawdown over time, 30/60/90-day returns next to
// simply holding BTC, and P&L per UTC day for the calendar. All from equity_snapshots
// (written by the executor every 10 s) and closed orders; all after fees.

import type { Db } from "./db/db.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

export type PerfPoint = { t: number; equity: number; drawdownPct: number };
export type DayPnl = { day: string; pnl: number; pnlPct: number };
export type WindowReturn = { days: number; actualDays: number; from: string | null; returnPct: number | null; btcPct: number | null };

export type Performance = {
  curve: PerfPoint[];
  daily: DayPnl[];
  windows: WindowReturn[];
  summary: {
    startEquity: number | null;
    equity: number | null;
    totalReturnPct: number | null;
    maxDrawdownPct: number;
    trades: number;
    wins: number;
    fees: number;
    realisedPnl: number;
  };
};

type Snap = { equity: number; high_water_mark: number; day_start_equity: number; created_at: string };

/** One point per bucket (the last equity in it): keeps the chart light however long it runs. */
function downsample(snaps: Snap[], bucketMs: number): PerfPoint[] {
  const out: PerfPoint[] = [];
  let bucket = -1;
  for (const s of snaps) {
    const t = Date.parse(s.created_at);
    const b = Math.floor(t / bucketMs);
    const point = { t, equity: s.equity, drawdownPct: s.high_water_mark > 0 ? Math.max(0, ((s.high_water_mark - s.equity) / s.high_water_mark) * 100) : 0 };
    if (b === bucket) out[out.length - 1] = point;
    else out.push(point);
    bucket = b;
  }
  return out;
}

function btcAt(db: Db, ms: number): number | null {
  const r = db.prepare("SELECT close FROM candles WHERE pair = 'BTC/USDT' AND open_time_ms <= ? ORDER BY open_time_ms DESC LIMIT 1").get(ms) as { close: number } | undefined;
  return r?.close ?? null;
}

export function readPerformance(db: Db, nowMs = Date.now()): Performance {
  const since = new Date(nowMs - 90 * DAY).toISOString();
  const snaps = db.prepare("SELECT equity, high_water_mark, day_start_equity, created_at FROM equity_snapshots WHERE created_at >= ? ORDER BY id").all(since) as Snap[];
  const first = db.prepare("SELECT equity, created_at FROM equity_snapshots ORDER BY id LIMIT 1").get() as { equity: number; created_at: string } | undefined;
  const last = snaps.at(-1) ?? null;

  // Short histories get finer points so the chart isn't two dots.
  const span = snaps.length ? Date.parse(last!.created_at) - Date.parse(snaps[0]!.created_at) : 0;
  const curve = downsample(snaps, span > 7 * DAY ? HOUR : span > DAY ? 10 * 60_000 : 60_000);

  // P&L per UTC day: the day's last equity minus that day's starting equity.
  const byDay = new Map<string, Snap>();
  for (const s of snaps) byDay.set(s.created_at.slice(0, 10), s);
  const daily = [...byDay.entries()].map(([day, s]) => ({ day, pnl: s.equity - s.day_start_equity, pnlPct: s.day_start_equity > 0 ? ((s.equity - s.day_start_equity) / s.day_start_equity) * 100 : 0 }));

  const btcNow = (db.prepare("SELECT last FROM price_state WHERE pair = 'BTC/USDT'").get() as { last: number | null } | undefined)?.last ?? btcAt(db, nowMs);
  const windows = [30, 60, 90].map((days): WindowReturn => {
    const start = db.prepare("SELECT equity, created_at FROM equity_snapshots WHERE created_at >= ? ORDER BY id LIMIT 1").get(new Date(nowMs - days * DAY).toISOString()) as { equity: number; created_at: string } | undefined;
    if (!start || !last) return { days, actualDays: 0, from: null, returnPct: null, btcPct: null };
    const fromMs = Date.parse(start.created_at);
    const btcThen = btcAt(db, fromMs);
    return {
      days,
      actualDays: Math.max(0, Math.round(((nowMs - fromMs) / DAY) * 10) / 10),
      from: start.created_at,
      returnPct: ((last.equity - start.equity) / start.equity) * 100,
      btcPct: btcThen && btcNow ? ((btcNow - btcThen) / btcThen) * 100 : null,
    };
  });

  const trades = db.prepare("SELECT realised_pnl, entry_fee, exit_fee FROM orders WHERE state = 'CLOSED' AND direction = 'long'").all() as { realised_pnl: number | null; entry_fee: number | null; exit_fee: number | null }[];
  return {
    curve,
    daily,
    windows,
    summary: {
      startEquity: first?.equity ?? null,
      equity: last?.equity ?? null,
      totalReturnPct: first && last ? ((last.equity - first.equity) / first.equity) * 100 : null,
      maxDrawdownPct: curve.reduce((m, p) => Math.max(m, p.drawdownPct), 0),
      trades: trades.length,
      wins: trades.filter((t) => (t.realised_pnl ?? 0) > 0).length,
      fees: trades.reduce((s, t) => s + (t.entry_fee ?? 0) + (t.exit_fee ?? 0), 0),
      realisedPnl: trades.reduce((s, t) => s + (t.realised_pnl ?? 0), 0),
    },
  };
}
