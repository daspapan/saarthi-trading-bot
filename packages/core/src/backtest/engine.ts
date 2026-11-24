// The backtester. It replays 15m candles through the SAME code live trading uses:
//   indicators.ts  -> strategies.ts (candidates, sizing)  -> validator.ts (risk rules)
// with a simulated exchange instead of Binance (BT-01, PAPER-02).
//
// Timing (no look-ahead, BT-04): decisions are made at a candle's CLOSE using
// only candles that have closed, and orders execute on the NEXT candle.
// A 4h candle only counts once its 4 hours are over.
//
// The AI is off by default (too slow for two years of candles): the
// deterministic best-scoring candidate per pair stands in for it. Replay mode
// instead follows a list of stored AI choices (BT-10).
//
// Deterministic (BT-08): no clock, no randomness. Same input, same result.

import { type SettingsFile, num } from "../config/settings.ts";
import { TIMEFRAMES, type Candle } from "../feed/candles.ts";
import { type IndicatorTable, indicatorTable, indicatorsAt } from "../indicators.ts";
import { type Account, type Position, riskLimitsFrom } from "../risk.ts";
import {
  type EntryCandidate,
  type PairMarket,
  type RatioStat,
  STRATEGIES,
  type StrategyName,
  generateCandidates,
  ratioZSeries,
} from "../strategies.ts";
import { type ValidatorLimits, allPassed, checkRiskRules } from "../validator.ts";
import {
  type EquityPoint,
  type Metrics,
  type TradeRecord,
  computeMetrics,
  downsample,
  drawdownCurve,
  maxDrawdown,
  cagr,
} from "./metrics.ts";
import { type Costs, DEFAULT_COSTS, checkStopAndTarget, feeFor, marketAtOpen, tryLimitBuy, withSlippage } from "./simExchange.ts";

const BAR = TIMEFRAMES["15m"];
const FOUR_H = TIMEFRAMES["4h"];
const DAY = 86_400_000;

/** One stored AI decision: at `time`, for `pair`, the AI picked this candidate (or none). */
export type ReplayChoice = { time: number; pair: string; candidateId: string | null };

export type BacktestInput = {
  pairs: string[];
  candles15: Record<string, Candle[]>;
  candles4h: Record<string, Candle[]>;
  /** Trade only between these times (indicators may warm up on earlier candles). */
  from: number;
  to: number;
  strategy: SettingsFile;
  risk: SettingsFile;
  only?: StrategyName | "all";
  startEquity?: number;
  costs?: Costs;
  /** Follow stored AI choices instead of the deterministic stand-in. */
  replay?: ReplayChoice[];
};

export type BacktestEvent = { time: number; kind: "daily-limit" | "drawdown-halt"; message: string };

export type BacktestResult = {
  metrics: Metrics;
  benchmark: { pair: string; totalReturn: number; cagr: number; maxDrawdown: number; curve: EquityPoint[] };
  curve: EquityPoint[];
  drawdown: EquityPoint[];
  trades: TradeRecord[];
  events: BacktestEvent[];
  rejections: Record<string, number>;
  bars: number;
  signalSource: "deterministic" | "ai-replay";
};

export function validatorLimitsFrom(risk: SettingsFile): ValidatorLimits {
  return {
    ...riskLimitsFrom(risk),
    maxTradesPerDay: num(risk, "maxTradesPerDay"),
    minRewardToRisk: num(risk, "minRewardToRisk"),
    stopAtrMin: num(risk, "stopAtrMin"),
    stopAtrMax: num(risk, "stopAtrMax"),
  };
}

/** Turns on one strategy and turns the others off. */
export function onlyStrategy(s: SettingsFile, only: StrategyName | "all" = "all"): SettingsFile {
  if (only === "all") return s;
  const out = { ...s };
  for (const name of STRATEGIES) out[`${name}.enabled`] = { value: name === only, help: s[`${name}.enabled`]?.help ?? "" };
  return out;
}

type OpenPosition = {
  pair: string;
  strategy: string;
  candidateId: string;
  quantity: number;
  entryPrice: number;
  entryTime: number;
  stop: number;
  target: number;
  fees: number;
  slippage: number;
};

type PendingOrder = { kind: "entry"; candidate: EntryCandidate } | { kind: "exit"; pair: string };

type PairData = {
  byTime: Map<number, number>;
  table15: IndicatorTable;
  table4h: IndicatorTable;
  candles4h: Candle[];
};

export function runBacktest(input: BacktestInput): BacktestResult {
  const costs = input.costs ?? DEFAULT_COSTS;
  const strategy = onlyStrategy(input.strategy, input.only);
  const limits = validatorLimitsFrom(input.risk);
  const riskNum = (k: string) => num(input.risk, k);
  const startEquity = input.startEquity ?? 10_000;

  // ---------- prepare data once ----------
  const data: Record<string, PairData> = {};
  for (const pair of input.pairs) {
    const c15 = input.candles15[pair] ?? [];
    const c4h = input.candles4h[pair] ?? [];
    data[pair] = {
      byTime: new Map(c15.map((c, i) => [c.openTimeMs, i])),
      table15: indicatorTable(c15, "15m"),
      table4h: indicatorTable(c4h, "4h"),
      candles4h: c4h,
    };
  }
  const master = (input.candles15[input.pairs[0]!] ?? []).filter((c) => c.openTimeMs >= input.from && c.openTimeMs < input.to);

  // BTC/ETH ratio z-score, by candle time (only where both pairs have a candle).
  const ratioByTime = new Map<number, RatioStat>();
  if (data["BTC/USDT"] && data["ETH/USDT"]) {
    const btc = input.candles15["BTC/USDT"]!;
    const ethIdx = data["ETH/USDT"].byTime;
    const common = btc.filter((c) => ethIdx.has(c.openTimeMs));
    const ethCloses = common.map((c) => input.candles15["ETH/USDT"]![ethIdx.get(c.openTimeMs)!]!.close);
    const z = ratioZSeries(common.map((c) => c.close), ethCloses, num(strategy, "statArb.lookbackCandles"));
    common.forEach((c, i) => z[i] && ratioByTime.set(c.openTimeMs, z[i]!));
  }

  const replayIds = input.replay ? new Set(input.replay.filter((r) => r.candidateId).map((r) => r.candidateId!)) : null;

  // ---------- state ----------
  let cash = startEquity;
  const positions = new Map<string, OpenPosition>();
  let pending: PendingOrder[] = [];
  const trades: TradeRecord[] = [];
  const curve: EquityPoint[] = [];
  const benchCurve: EquityPoint[] = [];
  const events: BacktestEvent[] = [];
  const rejections: Record<string, number> = {};
  const lastClose: Record<string, number> = {};
  const fourHPointer: Record<string, number> = {};
  let equity = startEquity;
  let highWater = startEquity;
  let currentDay = -1;
  let dayStartEquity = startEquity;
  let tradesToday = 0;
  let dailyLimitHit = false;
  let halted = false;
  let barsWithPosition = 0;

  // Benchmark: buy BTC (or the first pair) at the first open with all the money, hold to the end.
  const benchPair = input.pairs.includes("BTC/USDT") ? "BTC/USDT" : input.pairs[0]!;
  let benchQty = 0;

  const candleAt = (pair: string, t: number) => {
    const i = data[pair]?.byTime.get(t);
    return i === undefined ? undefined : input.candles15[pair]![i];
  };

  function closePosition(pos: OpenPosition, price: number, fee: number, slip: number, time: number, reason: TradeRecord["exitReason"]) {
    cash += price * pos.quantity - fee;
    const fees = pos.fees + fee;
    trades.push({
      pair: pos.pair,
      strategy: pos.strategy,
      candidateId: pos.candidateId,
      entryTime: pos.entryTime,
      exitTime: time,
      entryPrice: pos.entryPrice,
      exitPrice: price,
      quantity: pos.quantity,
      fees,
      slippage: pos.slippage + slip,
      pnl: (price - pos.entryPrice) * pos.quantity - fees,
      exitReason: reason,
    });
    positions.delete(pos.pair);
  }

  /** Close everything at each pair's latest close (drawdown halt, end of test). */
  function closeAll(time: number, reason: TradeRecord["exitReason"]) {
    for (const pos of [...positions.values()]) {
      const price = withSlippage(lastClose[pos.pair] ?? pos.entryPrice, "sell", costs);
      const fee = feeFor(price * pos.quantity, costs);
      closePosition(pos, price, fee, Math.abs((lastClose[pos.pair] ?? pos.entryPrice) - price) * pos.quantity, time, reason);
    }
  }

  // ---------- the loop ----------
  for (const bar of master) {
    const t = bar.openTimeMs;
    const decisionTime = t + BAR; // this candle's close

    // New UTC day: reset the daily counters.
    const day = Math.floor(t / DAY);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = equity;
      tradesToday = 0;
      dailyLimitHit = false;
    }

    if (benchQty === 0) {
      const price = withSlippage(bar.open, "buy", costs);
      benchQty = startEquity / (price * (1 + costs.feeBps / 10_000));
    }

    // 1. Orders placed at the previous close execute on this candle.
    for (const order of pending) {
      const pair = order.kind === "entry" ? order.candidate.pair : order.pair;
      const candle = candleAt(pair, t);
      if (!candle) continue; // no data: the order lapses
      if (order.kind === "entry") {
        const c = order.candidate;
        const f = tryLimitBuy(candle, c.entry, c.quantity, costs);
        if (!f) continue; // price never traded through the limit: cancelled, like the live 60 s timeout
        cash -= f.price * c.quantity + f.fee;
        positions.set(pair, {
          pair,
          strategy: c.strategy,
          candidateId: c.id,
          quantity: c.quantity,
          entryPrice: f.price,
          entryTime: t,
          stop: c.stop,
          target: c.target,
          fees: f.fee,
          slippage: f.slippage,
        });
      } else {
        const pos = positions.get(pair);
        if (!pos) continue;
        const f = marketAtOpen(candle, "sell", pos.quantity, costs);
        closePosition(pos, f.price, f.fee, f.slippage, t, "exit-signal");
      }
    }
    pending = [];

    // 2. Stops and targets (stop first if both are touched).
    for (const pos of [...positions.values()]) {
      const candle = candleAt(pos.pair, t);
      if (!candle) continue;
      const hit = checkStopAndTarget(candle, pos.stop, pos.target, pos.quantity, costs, pos.entryTime !== t);
      if (hit) closePosition(pos, hit.fill.price, hit.fill.fee, hit.fill.slippage, t, hit.reason);
    }

    // 3. Mark to market at the close.
    for (const pair of input.pairs) {
      const c = candleAt(pair, t);
      if (c) lastClose[pair] = c.close;
    }
    equity = cash + [...positions.values()].reduce((a, p) => a + p.quantity * (lastClose[p.pair] ?? p.entryPrice), 0);
    highWater = Math.max(highWater, equity);
    if (positions.size > 0) barsWithPosition += 1;

    // 4. Risk controls, exactly like live: daily loss limit and max drawdown.
    if (!dailyLimitHit && dayStartEquity > 0 && ((dayStartEquity - equity) / dayStartEquity) * 10_000 >= riskNum("dailyLossLimitBps")) {
      dailyLimitHit = true;
      events.push({ time: decisionTime, kind: "daily-limit", message: "Daily loss limit hit: no new entries until UTC midnight." });
    }
    if (!halted && ((highWater - equity) / highWater) * 10_000 >= riskNum("maxDrawdownBps")) {
      closeAll(decisionTime, "drawdown");
      equity = cash;
      halted = true;
      events.push({
        time: decisionTime,
        kind: "drawdown-halt",
        message: "Max drawdown reached: everything closed. Live, this needs a manual restart with the PIN; the backtest stops trading here.",
      });
    }

    curve.push({ time: decisionTime, equity });
    benchCurve.push({ time: decisionTime, equity: benchQty * (lastClose[benchPair] ?? bar.close) });
    if (halted) continue;

    // 5. Decide at this close: candidates -> pick -> validator risk rules -> order for the next candle.
    const markets: Record<string, PairMarket> = {};
    for (const pair of input.pairs) {
      const d = data[pair]!;
      const i = d.byTime.get(t);
      if (i === undefined) continue;
      // Latest 4h candle that has fully closed by now.
      let j = fourHPointer[pair] ?? -1;
      while (j + 1 < d.candles4h.length && d.candles4h[j + 1]!.openTimeMs + FOUR_H <= decisionTime) j++;
      fourHPointer[pair] = j;
      markets[pair] = {
        pair,
        price: input.candles15[pair]![i]!.close,
        ind15: indicatorsAt(d.table15, i),
        ind4h: j >= 0 ? indicatorsAt(d.table4h, j) : null,
      };
    }

    const account: Account = {
      equity,
      cash,
      positions: [...positions.values()].map((p): Position => ({ pair: p.pair, quantity: p.quantity, avgEntry: p.entryPrice, strategy: p.strategy })),
    };
    const { candidates } = generateCandidates({ time: decisionTime, account, markets, ratio: ratioByTime.get(t) ?? null, strategy, limits });

    const taken = new Set<string>();
    const pendingPositions: Position[] = [];
    let reserved = 0;
    for (const c of candidates) {
      if (c.direction === "exit") {
        pending.push({ kind: "exit", pair: c.pair });
        continue;
      }
      if (dailyLimitHit || taken.has(c.pair)) continue;
      if (replayIds && !replayIds.has(c.id)) continue; // replay: only what the AI actually chose
      const rules = checkRiskRules(
        c,
        {
          account: { ...account, cash: cash - reserved, positions: [...account.positions, ...pendingPositions] },
          prices: lastClose,
          pendingPairs: [],
          tradesToday,
          dailyLossLimitHit: dailyLimitHit,
        },
        limits,
      );
      if (!allPassed(rules)) {
        for (const r of rules) if (!r.passed) rejections[r.name] = (rejections[r.name] ?? 0) + 1;
        continue;
      }
      pending.push({ kind: "entry", candidate: c });
      taken.add(c.pair);
      pendingPositions.push({ pair: c.pair, quantity: c.quantity, avgEntry: c.entry });
      reserved += c.notional * (1 + costs.feeBps / 10_000);
      tradesToday += 1;
    }
  }

  // End of test: close what's still open so every trade has a result.
  const endTime = curve.at(-1)?.time ?? input.to;
  closeAll(endTime, "end");
  if (curve.length) {
    equity = cash;
    curve[curve.length - 1] = { time: endTime, equity };
  }

  const metrics = computeMetrics(curve, trades, master.length ? barsWithPosition / master.length : 0);
  if (benchCurve.length) {
    const last = benchCurve.at(-1)!;
    const exitPrice = withSlippage(lastClose[benchPair] ?? 0, "sell", costs);
    last.equity = benchQty * exitPrice - feeFor(benchQty * exitPrice, costs);
  }
  const benchEnd = benchCurve.at(-1)?.equity ?? startEquity;
  return {
    metrics,
    benchmark: {
      pair: benchPair,
      totalReturn: benchEnd / startEquity - 1,
      cagr: cagr(startEquity, benchEnd, metrics.days),
      maxDrawdown: maxDrawdown(benchCurve),
      curve: downsample(benchCurve),
    },
    curve: downsample(curve),
    drawdown: downsample(drawdownCurve(curve)),
    trades,
    events,
    rejections,
    bars: master.length,
    signalSource: replayIds ? "ai-replay" : "deterministic",
  };
}

// ---------- walk-forward ----------

export type WalkForward = {
  splitTime: number;
  inSample: Metrics;
  outOfSample: Metrics;
  warning: string | null;
};

/**
 * Splits the period (70% / 30% by default) and runs each half separately with
 * the same settings. Nothing is tuned on the first half, so if the halves look
 * very different, the result is more luck than edge, and we say so.
 */
export function walkForward(input: BacktestInput, inSampleShare = 0.7): WalkForward {
  const splitRaw = input.from + (input.to - input.from) * inSampleShare;
  const splitTime = Math.floor(splitRaw / BAR) * BAR;
  const inSample = runBacktest({ ...input, to: splitTime }).metrics;
  const outOfSample = runBacktest({ ...input, from: splitTime }).metrics;
  return { splitTime, inSample, outOfSample, warning: walkForwardWarning(inSample, outOfSample) };
}

export function walkForwardWarning(a: Metrics, b: Metrics): string | null {
  if (a.trades < 5 || b.trades < 5) {
    return `Too few trades to compare the two periods (${a.trades} in-sample, ${b.trades} out-of-sample). Treat these results as anecdotes.`;
  }
  if (Math.sign(a.cagr) !== Math.sign(b.cagr)) {
    return `The two periods disagree: ${(a.cagr * 100).toFixed(1)}% a year in-sample vs ${(b.cagr * 100).toFixed(1)}% out-of-sample. The edge may not be real.`;
  }
  if (a.sharpe !== null && b.sharpe !== null && a.sharpe > 0 && b.sharpe < a.sharpe * 0.5) {
    return `Out-of-sample Sharpe (${b.sharpe.toFixed(2)}) is less than half of in-sample (${a.sharpe.toFixed(2)}). Expect live results to be weaker.`;
  }
  return null;
}
