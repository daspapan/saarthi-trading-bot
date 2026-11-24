// Backtest report maths. Plain formulas, written out so they can be checked by hand.
//
//   total return   end / start - 1
//   CAGR           (end / start) ^ (365 / days) - 1
//   Sharpe         mean(daily return) / stdev(daily return) x sqrt(365), risk-free rate 0
//   Sortino        mean(daily return) / downside deviation x sqrt(365)
//                  downside deviation = sqrt(mean(min(r, 0)^2)) over ALL days
//   max drawdown   largest fall from a running peak, as a fraction of that peak
//   win rate       winning trades / all trades
//   profit factor  sum of winning P&L / |sum of losing P&L|  (null if there are no losses)
//   exposure       share of candles with at least one open position
// Crypto trades every day, so a year is 365 days.

export type EquityPoint = { time: number; equity: number };

export type TradeRecord = {
  pair: string;
  strategy: string;
  /** The candidate this trade came from (lets AI replay and the UI trace it back). */
  candidateId: string;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  fees: number;
  slippage: number;
  pnl: number; // net of fees (and slippage, which is already in the prices)
  exitReason: "target" | "stop" | "exit-signal" | "drawdown" | "end";
};

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

const DAY = 86_400_000;

/** Last equity value of each UTC day, in order. */
export function dailyCloses(curve: readonly EquityPoint[]): EquityPoint[] {
  const out: EquityPoint[] = [];
  for (const p of curve) {
    const day = Math.floor(p.time / DAY) * DAY;
    const last = out.at(-1);
    if (last && last.time === day) last.equity = p.equity;
    else out.push({ time: day, equity: p.equity });
  }
  return out;
}

export function dailyReturns(curve: readonly EquityPoint[]): number[] {
  const d = dailyCloses(curve);
  const out: number[] = [];
  for (let i = 1; i < d.length; i++) out.push(d[i]!.equity / d[i - 1]!.equity - 1);
  return out;
}

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Sample standard deviation (n - 1). */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export function sharpe(returns: readonly number[]): number | null {
  const sd = stdev(returns);
  return returns.length < 2 || sd === 0 ? null : (mean(returns) / sd) * Math.sqrt(365);
}

export function sortino(returns: readonly number[]): number | null {
  if (returns.length < 2) return null;
  const downside = Math.sqrt(mean(returns.map((r) => Math.min(r, 0) ** 2)));
  return downside === 0 ? null : (mean(returns) / downside) * Math.sqrt(365);
}

export function maxDrawdown(curve: readonly EquityPoint[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) worst = Math.max(worst, (peak - p.equity) / peak);
  }
  return worst;
}

export function drawdownCurve(curve: readonly EquityPoint[]): EquityPoint[] {
  let peak = -Infinity;
  return curve.map((p) => {
    peak = Math.max(peak, p.equity);
    return { time: p.time, equity: peak > 0 ? -(peak - p.equity) / peak : 0 };
  });
}

export function cagr(start: number, end: number, days: number): number {
  if (days <= 0 || start <= 0) return 0;
  return (end / start) ** (365 / days) - 1;
}

export function computeMetrics(curve: readonly EquityPoint[], trades: readonly TradeRecord[], exposure: number): Metrics {
  const start = curve[0]?.equity ?? 0;
  const end = curve.at(-1)?.equity ?? start;
  const days = curve.length > 1 ? (curve.at(-1)!.time - curve[0]!.time) / DAY : 0;
  const returns = dailyReturns(curve);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    startEquity: start,
    endEquity: end,
    totalReturn: start > 0 ? end / start - 1 : 0,
    cagr: cagr(start, end, days),
    sharpe: sharpe(returns),
    sortino: sortino(returns),
    maxDrawdown: maxDrawdown(curve),
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgTradeDurationHours: trades.length ? mean(trades.map((t) => (t.exitTime - t.entryTime) / 3_600_000)) : null,
    exposure,
    totalFees: trades.reduce((a, t) => a + t.fees, 0),
    totalSlippage: trades.reduce((a, t) => a + t.slippage, 0),
    days,
  };
}

/** Keeps at most `max` points (always the first and last), for charts. */
export function downsample<T>(points: readonly T[], max = 800): T[] {
  if (points.length <= max) return [...points];
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}
