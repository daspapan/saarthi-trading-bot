// Types and pure helpers for the Backtest Lab (unit-tested, no React here).

export type Metrics = {
  startEquity: number;
  endEquity: number;
  totalReturn: number;
  cagr: number;
  sharpe: number | null;
  sortino: number | null;
  maxDrawdown: number;
  trades: number;
  winRate: number | null;
  profitFactor: number | null;
  avgTradeDurationHours: number | null;
  exposure: number;
  totalFees: number;
  totalSlippage: number;
  days: number;
};

export type Point = { time: number; equity: number };

export type Trade = {
  pair: string;
  strategy: string;
  candidateId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: number;
  slippage: number;
  pnl: number;
  exitReason: string;
};

export type Run = {
  id: number;
  label: string | null;
  strategy: string;
  status: "running" | "done" | "failed";
  error: string | null;
  from: number;
  to: number;
  createdAt: string;
  params: { slippageBps: number; overrides: Record<string, number | boolean | string> };
  metrics: Metrics | null;
  curve: Point[] | null;
  drawdown?: Point[];
  benchmark?: { pair: string; totalReturn: number; cagr: number; maxDrawdown: number; curve: Point[] };
  walkForward?: { splitTime: number; inSample: Metrics; outOfSample: Metrics; warning: string | null };
  events?: { time: number; kind: string; message: string }[];
  rejections?: Record<string, number>;
  costs?: { feeBps: number; slippageBps: number };
  trades: Trade[];
  totalTrades: number;
};

export type RunSummary = {
  id: number;
  label: string | null;
  strategy: string;
  status: Run["status"];
  error: string | null;
  from: number;
  to: number;
  createdAt: string;
  summary: { totalReturn: number; cagr: number; sharpe: number | null; maxDrawdown: number; trades: number; benchmarkReturn: number | null } | null;
};

export const STRATEGY_NAMES: Record<string, string> = {
  all: "All three strategies",
  statArb: "Stat-arb (BTC/ETH)",
  momentum: "Momentum",
  meanReversion: "Mean reversion",
};

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(digits)}%`;
}

/** Percent without a sign (for things that are always positive, like drawdown or win rate). */
export function fmtPlainPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtRatio(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return v.toFixed(2);
}

export function fmtHours(h: number | null | undefined): string {
  if (h === null || h === undefined || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "2026-01-31" for an <input type="date">, in UTC. */
export function toDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** <input type="date"> value -> UTC midnight in ms (null if empty or invalid). */
export function fromDateInput(s: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export type Tone = "up" | "down" | "flat";
export const toneOf = (v: number | null | undefined): Tone => (!v || !Number.isFinite(v) ? "flat" : v > 0 ? "up" : "down");

/** Equity as % change from the start, so runs with different periods can share one chart. */
export function normalise(points: readonly Point[]): { time: number; pct: number }[] {
  const start = points[0]?.equity;
  if (!start) return [];
  return points.map((p) => ({ time: p.time, pct: (p.equity / start - 1) * 100 }));
}

/** Rows for the side-by-side comparison table: [label, value per run]. */
export function compareRows(runs: readonly Pick<Run, "metrics" | "benchmark">[]): [string, string[]][] {
  const m = (f: (x: Metrics) => string) => runs.map((r) => (r.metrics ? f(r.metrics) : "—"));
  return [
    ["Total return", m((x) => fmtPct(x.totalReturn))],
    ["BTC buy & hold", runs.map((r) => fmtPct(r.benchmark?.totalReturn))],
    ["CAGR", m((x) => fmtPct(x.cagr))],
    ["Sharpe", m((x) => fmtRatio(x.sharpe))],
    ["Sortino", m((x) => fmtRatio(x.sortino))],
    ["Max drawdown", m((x) => fmtPlainPct(x.maxDrawdown))],
    ["Win rate", m((x) => fmtPlainPct(x.winRate, 0))],
    ["Profit factor", m((x) => fmtRatio(x.profitFactor))],
    ["Trades", m((x) => String(x.trades))],
    ["Fees paid", m((x) => fmtUsd(x.totalFees))],
  ];
}

export const EXIT_LABELS: Record<string, string> = {
  target: "Target hit",
  stop: "Stop hit",
  "exit-signal": "Gap closed",
  drawdown: "Drawdown stop",
  end: "Test ended",
};
