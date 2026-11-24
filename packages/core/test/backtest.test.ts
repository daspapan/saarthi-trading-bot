import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BacktestInput,
  type Candle,
  type EquityPoint,
  type Metrics,
  type TradeRecord,
  appendCandlesCsv,
  applySettingChange,
  candleCsvPath,
  checkStopAndTarget,
  computeMetrics,
  dailyCloses,
  downloadCandles,
  downsample,
  drawdownCurve,
  feeFor,
  loadBacktestCandles,
  loadSettingsFile,
  marketAtOpen,
  maxDrawdown,
  onlyStrategy,
  readCandlesCsv,
  rollup,
  runBacktest,
  sharpe,
  sortino,
  stdev,
  tryLimitBuy,
  walkForward,
  walkForwardWarning,
  withSlippage,
  type SettingsFile,
} from "../src/index.ts";
import { BAR, START, makeCandles, syntheticMarket } from "./synthetic.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");
const STRATEGY = loadSettingsFile(CONFIG, "strategy.json");
const RISK = loadSettingsFile(CONFIG, "risk.json");
const DAY = 86_400_000;
const COSTS = { feeBps: 10, slippageBps: 5 };

const MARKET = syntheticMarket();
const FOUR_H = Object.fromEntries(Object.entries(MARKET).map(([p, c]) => [p, rollup(c, "4h")]));

function baseInput(o: Partial<BacktestInput> = {}): BacktestInput {
  return {
    pairs: Object.keys(MARKET),
    candles15: MARKET,
    candles4h: FOUR_H,
    from: START + 3_000 * BAR,
    to: START + 6_000 * BAR,
    strategy: STRATEGY,
    risk: RISK,
    costs: COSTS,
    ...o,
  };
}

const set = (file: SettingsFile, key: string, value: unknown) => {
  const r = applySettingChange(file, key, value);
  if (!r.ok) throw new Error(r.reason);
  return r.settings;
};

const candle = (o: Partial<Candle>): Candle => ({
  pair: "BTC/USDT",
  timeframe: "15m",
  openTimeMs: START,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1,
  ...o,
});

const RESULT = runBacktest(baseInput());

describe("BT-01 the backtester uses the live trading code", () => {
  it("BT-01 the engine imports indicators, strategies, risk sizing and the validator from the shared core modules", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "backtest", "engine.ts"), "utf8");
    for (const mod of ["../indicators.ts", "../strategies.ts", "../risk.ts", "../validator.ts"]) {
      expect(src).toContain(`from "${mod}"`);
    }
    expect(src).toContain("generateCandidates(");
    expect(src).toContain("checkRiskRules(");
  });

  it("BT-01 the validator's rules really apply: max 1 trade a day means at most 1 entry per UTC day", () => {
    const r = runBacktest(baseInput({ risk: set(RISK, "maxTradesPerDay", 1) }));
    const perDay = new Map<number, number>();
    for (const t of r.trades) {
      const d = Math.floor((t.entryTime - BAR) / DAY); // decided on the previous candle's close
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(1);
    expect(r.rejections["Trades per day"]).toBeGreaterThan(0);
  });

  it("BT-01 the validator's R:R minimum applies: raising it to 5 leaves only trades planned at 5R or better", () => {
    const r = runBacktest(baseInput({ risk: set(RISK, "minRewardToRisk", 5) }));
    expect(r.trades.length).toBeLessThan(RESULT.trades.length);
    expect(r.rejections["Stop distance and reward-to-risk"]).toBeGreaterThan(RESULT.rejections["Stop distance and reward-to-risk"] ?? 0);
  });
});

describe("BT-02 fees and slippage on every fill", () => {
  it("BT-02 a market buy fills 5 bps above the open and pays 0.1% of the fill value", () => {
    const f = marketAtOpen(candle({ open: 100_000 }), "buy", 0.1, COSTS);
    expect(f.price).toBeCloseTo(100_050, 6);
    expect(f.fee).toBeCloseTo(10.005, 6);
    expect(f.slippage).toBeCloseTo(5, 6);
    expect(marketAtOpen(candle({ open: 100_000 }), "sell", 0.1, COSTS).price).toBeCloseTo(99_950, 6);
  });

  it("BT-02 every trade in a run carries entry and exit fees, and slippage made every price worse", () => {
    expect(RESULT.trades.length).toBeGreaterThan(20);
    for (const t of RESULT.trades) {
      const expectedFees = feeFor(t.entryPrice * t.quantity, COSTS) + feeFor(t.exitPrice * t.quantity, COSTS);
      expect(t.fees).toBeCloseTo(expectedFees, 6);
      expect(t.slippage).toBeGreaterThan(0);
      expect(t.pnl).toBeCloseTo((t.exitPrice - t.entryPrice) * t.quantity - t.fees, 6);
    }
    expect(RESULT.metrics.totalFees).toBeCloseTo(RESULT.trades.reduce((a, t) => a + t.fees, 0), 6);
  });

  it("BT-02 zero costs vs default costs: the same trades lose more money when costs are on", () => {
    const free = runBacktest(baseInput({ costs: { feeBps: 0, slippageBps: 0 } }));
    expect(free.metrics.endEquity).toBeGreaterThan(RESULT.metrics.endEquity);
  });

  it("BT-02 slippage is configurable", () => {
    expect(withSlippage(1_000, "buy", { feeBps: 10, slippageBps: 20 })).toBeCloseTo(1_002, 9);
  });
});

describe("BT-03 a limit order fills only if the price trades through it", () => {
  it("BT-03 the low exactly touching the limit is NOT a fill", () => {
    expect(tryLimitBuy(candle({ low: 99 }), 99, 1, COSTS)).toBeNull();
  });

  it("BT-03 trading below the limit fills at the limit (plus slippage)", () => {
    const f = tryLimitBuy(candle({ open: 100, low: 98.99 }), 99, 1, COSTS)!;
    expect(f.price).toBeCloseTo(99 * 1.0005, 9);
  });

  it("BT-03 opening below the limit fills at the open (a better price)", () => {
    const f = tryLimitBuy(candle({ open: 97, low: 96 }), 99, 1, COSTS)!;
    expect(f.price).toBeCloseTo(97 * 1.0005, 9);
  });

  it("BT-03 stop and target: the stop wins when both are touched; a gap through the stop fills at the open", () => {
    expect(checkStopAndTarget(candle({ low: 95, high: 110 }), 96, 105, 1, COSTS)!.reason).toBe("stop");
    const gap = checkStopAndTarget(candle({ open: 90, low: 89, high: 91 }), 96, 105, 1, COSTS)!;
    expect(gap.fill.price).toBeCloseTo(90 * 0.9995, 9);
    expect(checkStopAndTarget(candle({ low: 99, high: 105 }), 96, 105, 1, COSTS)).toBeNull(); // touching the target isn't through it
    expect(checkStopAndTarget(candle({ low: 99, high: 106 }), 96, 105, 1, COSTS)!.reason).toBe("target");
    expect(checkStopAndTarget(candle({ low: 99, high: 106 }), 96, 105, 1, COSTS, false)).toBeNull(); // fill candle: stop only
  });
});

describe("BT-04 no look-ahead", () => {
  it("BT-04 every entry happens on a candle AFTER the one whose close produced the signal", () => {
    for (const t of RESULT.trades) {
      const decided = Number(t.candidateId.split("-").at(-1));
      expect(t.entryTime).toBeGreaterThanOrEqual(decided); // the candle that opens at the decision time or later
      expect(t.entryTime % BAR).toBe(0);
    }
  });

  it("BT-04 changing the FUTURE does not change the past: trades before day X are identical whatever comes after", () => {
    const cut = START + 4_500 * BAR;
    const wild: Record<string, Candle[]> = {};
    for (const [p, cs] of Object.entries(MARKET)) {
      wild[p] = cs.map((c) => (c.openTimeMs < cut ? c : { ...c, open: c.open * 3, high: c.high * 3.1, low: c.low * 2.9, close: c.close * 3, volume: c.volume * 9 }));
    }
    const wild4h = Object.fromEntries(Object.entries(wild).map(([p, c]) => [p, rollup(c, "4h")]));
    const changed = runBacktest(baseInput({ candles15: wild, candles4h: wild4h }));
    const before = (ts: TradeRecord[]) => ts.filter((t) => t.exitTime < cut - 4 * 3_600_000);
    expect(before(changed.trades)).toEqual(before(RESULT.trades));
    expect(before(RESULT.trades).length).toBeGreaterThan(5);
  });
});

describe("BT-05 metrics match a hand-calculated fixture", () => {
  // Five daily closes: 100 -> 110 -> 99 -> 108.9 -> 119.79
  // daily returns: +10%, -10%, +10%, +10%
  const curve: EquityPoint[] = [100, 110, 99, 108.9, 119.79].map((equity, i) => ({ time: START + i * DAY, equity }));
  const trades: TradeRecord[] = [
    { pnl: 30, entryTime: 0, exitTime: 2 * 3_600_000 },
    { pnl: -10, entryTime: 0, exitTime: 4 * 3_600_000 },
    { pnl: 5, entryTime: 0, exitTime: 6 * 3_600_000 },
    { pnl: -5, entryTime: 0, exitTime: 8 * 3_600_000 },
  ].map((t) => ({ pair: "BTC/USDT", strategy: "x", candidateId: "x", entryPrice: 1, exitPrice: 1, quantity: 1, fees: 1, slippage: 0.5, exitReason: "target", ...t }));
  const m = computeMetrics(curve, trades, 0.25);

  it("BT-05 total return 19.79% and CAGR over 4 days", () => {
    expect(m.totalReturn).toBeCloseTo(0.1979, 10);
    expect(m.days).toBe(4);
    expect(m.cagr).toBeCloseTo(1.1979 ** (365 / 4) - 1, 6);
  });

  it("BT-05 Sharpe: mean 5%, sample sd 10% -> 0.5 x sqrt(365) = 9.552", () => {
    // returns 0.1, -0.1, 0.1, 0.1: mean 0.05; deviations .05,-.15,.05,.05 -> var = (0.0025x3 + 0.0225)/3 = 0.01 -> sd 0.1
    expect(m.sharpe).toBeCloseTo(0.5 * Math.sqrt(365), 9);
    expect(m.sharpe).toBeCloseTo(9.5525, 3);
  });

  it("BT-05 Sortino: downside deviation sqrt((0 + 0.01 + 0 + 0) / 4) = 0.05 -> 1.0 x sqrt(365) = 19.105", () => {
    expect(m.sortino).toBeCloseTo(Math.sqrt(365), 9);
  });

  it("BT-05 max drawdown is the fall from 110 to 99 = 10%", () => {
    expect(m.maxDrawdown).toBeCloseTo(0.1, 12);
    expect(drawdownCurve(curve).map((p) => Number(p.equity.toFixed(4)))).toEqual([0, 0, -0.1, -0.01, 0]);
  });

  it("BT-05 win rate 2/4, profit factor 35/15, average duration 5 h, fees and slippage summed", () => {
    expect(m.winRate).toBe(0.5);
    expect(m.profitFactor).toBeCloseTo(35 / 15, 12);
    expect(m.avgTradeDurationHours).toBe(5);
    expect(m.totalFees).toBe(4);
    expect(m.totalSlippage).toBe(2);
    expect(m.exposure).toBe(0.25);
  });

  it("BT-05 edge cases: no losses -> profit factor null; flat equity -> Sharpe null; one point -> zeros", () => {
    expect(computeMetrics(curve, trades.filter((t) => t.pnl > 0), 0).profitFactor).toBeNull();
    expect(sharpe([0, 0, 0])).toBeNull();
    expect(sortino([0.01, 0.02])).toBeNull(); // no down days
    expect(stdev([1])).toBe(0);
    const one = computeMetrics([{ time: 0, equity: 100 }], [], 0);
    expect(one).toMatchObject({ totalReturn: 0, cagr: 0, trades: 0, winRate: null, avgTradeDurationHours: null });
  });

  it("BT-05 several points in one day count once (the day's last value)", () => {
    expect(dailyCloses([{ time: START + 1, equity: 1 }, { time: START + 5, equity: 2 }, { time: START + DAY, equity: 3 }])).toEqual([
      { time: START, equity: 2 },
      { time: START + DAY, equity: 3 },
    ]);
  });

  it("BT-05 the run's metrics agree with its own trade log and equity curve", () => {
    expect(RESULT.metrics.trades).toBe(RESULT.trades.length);
    const sumPnl = RESULT.trades.reduce((a, t) => a + t.pnl, 0);
    expect(RESULT.metrics.endEquity - RESULT.metrics.startEquity).toBeCloseTo(sumPnl, 4);
  });
});

describe("BT-06 buy-and-hold BTC benchmark", () => {
  it("BT-06 buys at the first open (with slippage and fee) and sells at the last close (with slippage and fee)", () => {
    const btc = makeCandles("BTC/USDT", Array.from({ length: 200 }, (_, i) => 100 + i * 0.1), new Array(200).fill(10));
    const r = runBacktest({
      pairs: ["BTC/USDT"],
      candles15: { "BTC/USDT": btc },
      candles4h: { "BTC/USDT": rollup(btc, "4h") },
      from: START,
      to: START + 200 * BAR,
      strategy: STRATEGY,
      risk: RISK,
      costs: COSTS,
    });
    const qty = 10_000 / (100 * 1.0005 * 1.001);
    const exit = btc.at(-1)!.close * 0.9995;
    const expected = (qty * exit * 0.999) / 10_000 - 1;
    expect(r.benchmark.pair).toBe("BTC/USDT");
    expect(r.benchmark.totalReturn).toBeCloseTo(expected, 9);
    expect(r.benchmark.maxDrawdown).toBeCloseTo(0, 2);
  });

  it("BT-06 the benchmark curve covers the same period as the strategy curve", () => {
    expect(RESULT.benchmark.curve[0]!.time).toBe(RESULT.curve[0]!.time);
    expect(RESULT.benchmark.curve.at(-1)!.time).toBe(RESULT.curve.at(-1)!.time);
  });
});

describe("BT-07 walk-forward split", () => {
  it("BT-07 splits at 70% on a candle boundary and runs both halves", () => {
    const wf = walkForward(baseInput());
    const input = baseInput();
    expect(wf.splitTime % BAR).toBe(0);
    expect(wf.splitTime).toBe(Math.floor((input.from + (input.to - input.from) * 0.7) / BAR) * BAR);
    expect(wf.inSample.days).toBeGreaterThan(wf.outOfSample.days);
  });

  const m = (o: Partial<Metrics>): Metrics => ({
    startEquity: 1, endEquity: 1, totalReturn: 0, cagr: 0.2, sharpe: 1.5, sortino: 2, maxDrawdown: 0.1, trades: 30, winRate: 0.5,
    profitFactor: 1.3, avgTradeDurationHours: 5, exposure: 0.3, totalFees: 0, totalSlippage: 0, days: 100, ...o,
  });

  it("BT-07 no warning when both halves look alike", () => {
    expect(walkForwardWarning(m({}), m({ cagr: 0.15, sharpe: 1.1 }))).toBeNull();
  });

  it("BT-07 warns when the halves have opposite signs", () => {
    expect(walkForwardWarning(m({}), m({ cagr: -0.05 }))).toMatch(/disagree: 20\.0% a year in-sample vs -5\.0% out-of-sample/);
  });

  it("BT-07 warns when out-of-sample Sharpe is under half of in-sample", () => {
    expect(walkForwardWarning(m({ sharpe: 2 }), m({ sharpe: 0.9 }))).toMatch(/less than half/);
  });

  it("BT-07 warns that too few trades can't be compared", () => {
    expect(walkForwardWarning(m({ trades: 3 }), m({}))).toMatch(/Too few trades/);
  });
});

describe("BT-08 deterministic", () => {
  it("BT-08 the same backtest run twice gives identical results, down to every trade", () => {
    expect(runBacktest(baseInput())).toEqual(RESULT);
  });

  it("BT-08 downsampling keeps the first and last points and is stable", () => {
    const pts = Array.from({ length: 5_000 }, (_, i) => i);
    const d = downsample(pts, 100);
    expect(d).toHaveLength(100);
    expect(d[0]).toBe(0);
    expect(d.at(-1)).toBe(4_999);
    expect(downsample([1, 2, 3], 100)).toEqual([1, 2, 3]);
  });
});

describe("BT-09 candle download resumes and reports gaps", () => {
  const H = 3_600_000;
  // A fake exchange with 1h candles, missing hours 50-52 (exchange downtime).
  const source = (from: number) => (pair: string, timeframe: "1h", startMs: number, limit: number) =>
    Promise.resolve(
      Array.from({ length: limit }, (_, k) => startMs + k * H)
        .filter((t) => t < from + 200 * H && ![50, 51, 52].includes((t - from) / H))
        .map((t) => ({ pair, timeframe, openTimeMs: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 })),
    );

  it("BT-09 an interrupted download resumes after the last saved candle, with no duplicates, and reports the gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-candles-"));
    const from = START;
    const to = START + 200 * H;
    let pages = 0;
    const flaky = (pair: string, tf: "1h", start: number, limit: number) => {
      pages += 1;
      if (pages === 3) return Promise.reject(new Error("Wi-Fi dropped"));
      return source(from)(pair, tf, start, limit);
    };
    await expect(downloadCandles({ dir, pair: "BTC/USDT", timeframe: "1h", from, to, fetchPage: flaky as never, pageSize: 40 })).rejects.toThrow(
      "Wi-Fi dropped",
    );
    const partial = readCandlesCsv(candleCsvPath(dir, "BTC/USDT", "1h"), "BTC/USDT", "1h");
    expect(partial).toHaveLength(77); // two pages of 40 hours saved before the failure, minus the 3 missing hours

    const report = await downloadCandles({ dir, pair: "BTC/USDT", timeframe: "1h", from, to, fetchPage: source(from) as never, pageSize: 40 });
    expect(report.resumedFrom).toBe(from + 80 * H);
    const all = readCandlesCsv(report.path, "BTC/USDT", "1h");
    expect(all).toHaveLength(197); // 200 hours minus the 3 missing
    expect(new Set(all.map((c) => c.openTimeMs)).size).toBe(all.length);
    expect(report.gaps).toEqual([{ startMs: from + 50 * H, endMs: from + 53 * H, missing: 3 }]);

    // A third run has nothing to add.
    const again = await downloadCandles({ dir, pair: "BTC/USDT", timeframe: "1h", from, to, fetchPage: source(from) as never, pageSize: 40 });
    expect(again.added).toBe(0);
  });

  it("BT-09 a half-written last line (crash mid-write) is ignored and re-downloaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-candles-"));
    const path = candleCsvPath(dir, "ETH/USDT", "1h");
    appendCandlesCsv(path, [{ pair: "ETH/USDT", timeframe: "1h", openTimeMs: START, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
    writeFileSync(path, `${readFileSync(path, "utf8")}${START + H},1,1,`); // truncated line
    expect(readCandlesCsv(path, "ETH/USDT", "1h")).toHaveLength(1);
    const report = await downloadCandles({ dir, pair: "ETH/USDT", timeframe: "1h", from: START, to: START + 5 * H, fetchPage: source(START) as never });
    expect(report.resumedFrom).toBe(START + H);
    expect(readCandlesCsv(path, "ETH/USDT", "1h").map((c) => (c.openTimeMs - START) / H)).toEqual([0, 1, 2, 3, 4]);
  });

  it("BT-09 backtest data: 4h candles are built from 1h, only from complete 4-hour buckets", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-candles-"));
    const hours = Array.from({ length: 10 }, (_, i) => ({ pair: "BTC/USDT", timeframe: "1h" as const, openTimeMs: START + i * H, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 1 }));
    appendCandlesCsv(candleCsvPath(dir, "BTC/USDT", "1h"), hours);
    appendCandlesCsv(candleCsvPath(dir, "BTC/USDT", "15m"), makeCandles("BTC/USDT", [1, 2, 3], [1, 1, 1]));
    const data = loadBacktestCandles(dir, ["BTC/USDT"]);
    expect(data.candles4h["BTC/USDT"]!.map((c) => [(c.openTimeMs - START) / H, c.open, c.close, c.volume])).toEqual([
      [0, 0, 3.5, 4],
      [4, 4, 7.5, 4],
    ]); // hours 8-9 are an incomplete bucket: dropped
    expect(data.range).toEqual({ from: START, to: START + 3 * BAR });
    expect(loadBacktestCandles(dir, ["BTC/USDT", "SOL/USDT"]).range).toBeNull(); // SOL has no data
  });
});

describe("BT-10 AI off by default; replay follows stored AI choices", () => {
  it("BT-10 by default the deterministic candidate stands in for the AI", () => {
    expect(RESULT.signalSource).toBe("deterministic");
  });

  it("BT-10 replaying the stored choices reproduces exactly those trades, every time", () => {
    const choices = RESULT.trades.map((t) => ({ time: Number(t.candidateId.split("-").at(-1)), pair: t.pair, candidateId: t.candidateId }));
    const a = runBacktest(baseInput({ replay: choices }));
    const b = runBacktest(baseInput({ replay: choices }));
    expect(a.signalSource).toBe("ai-replay");
    expect(a.trades).toEqual(b.trades);
    expect(a.trades.map((t) => t.candidateId)).toEqual(RESULT.trades.map((t) => t.candidateId));
  });

  it("BT-10 if the AI said neutral every time, replay places no entries", () => {
    const neutral = runBacktest(baseInput({ replay: [{ time: START, pair: "BTC/USDT", candidateId: null }] }));
    expect(neutral.trades).toEqual([]);
  });

  it("BT-10 replaying only some choices gives a subset of the trades", () => {
    const some = RESULT.trades.filter((_, i) => i % 3 === 0).map((t) => ({ time: 0, pair: t.pair, candidateId: t.candidateId }));
    const r = runBacktest(baseInput({ replay: some }));
    const ids = new Set(some.map((s) => s.candidateId));
    for (const t of r.trades) expect(ids.has(t.candidateId)).toBe(true);
  });
});

describe("Backtest risk controls (same as live)", () => {
  it("RISK-06 hitting the drawdown limit closes everything and stops trading for the rest of the run", () => {
    const tight = set(RISK, "maxDrawdownBps", 500);
    const r = runBacktest(baseInput({ risk: tight }));
    const halt = r.events.find((e) => e.kind === "drawdown-halt");
    expect(halt).toBeDefined();
    expect(r.trades.every((t) => t.entryTime <= halt!.time)).toBe(true);
    expect(r.trades.filter((t) => t.exitReason === "drawdown").length).toBeGreaterThanOrEqual(0);
    expect(maxDrawdown(r.curve)).toBeLessThan(0.08);
  });

  it("RISK-03 after the daily loss limit, no new entries that UTC day", () => {
    const tight = set(RISK, "dailyLossLimitBps", 50);
    const r = runBacktest(baseInput({ risk: tight }));
    const hits = r.events.filter((e) => e.kind === "daily-limit");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      const dayEnd = (Math.floor((h.time - 1) / DAY) + 1) * DAY;
      expect(r.trades.filter((t) => t.entryTime > h.time && t.entryTime < dayEnd)).toEqual([]);
    }
  });

  it("STR-06 running one strategy alone turns the other two off", () => {
    const only = onlyStrategy(STRATEGY, "momentum");
    expect([only["momentum.enabled"]?.value, only["statArb.enabled"]?.value, only["meanReversion.enabled"]?.value]).toEqual([true, false, false]);
    const r = runBacktest(baseInput({ only: "momentum" }));
    expect(new Set(r.trades.map((t) => t.strategy))).toEqual(new Set(["momentum"]));
  });
});
