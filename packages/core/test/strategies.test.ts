import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  type Account,
  type CandidateInput,
  type EntryCandidate,
  type IndicatorSet,
  type PairMarket,
  applySettingChange,
  checkRiskRules,
  allPassed,
  exposureOf,
  floorQty,
  generateCandidates,
  loadSettingsFile,
  meanReversionSetup,
  momentumSetup,
  ratioZSeries,
  riskLimitsFrom,
  sizePosition,
  type SettingsFile,
} from "../src/index.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");
const STRATEGY = loadSettingsFile(CONFIG, "strategy.json");
const RISK = loadSettingsFile(CONFIG, "risk.json");
const LIMITS = riskLimitsFrom(RISK);
const T = Date.UTC(2026, 0, 5, 12, 0);

const set = (o: Partial<IndicatorSet> = {}): IndicatorSet => ({
  time: T,
  close: 100,
  rsi: 50,
  macd: { macd: 0, signal: 0, histogram: 0 },
  prevMacd: null,
  bollinger: { upper: 110, middle: 100, lower: 90, widthPct: 20 },
  atr: 2,
  volumeRatio: 1,
  ...o,
});

/** A market where momentum's conditions all hold (BTC at 100,000). */
const momentumMarket = (pair = "BTC/USDT", o15: Partial<IndicatorSet> = {}, o4h: Partial<IndicatorSet> = {}): PairMarket => ({
  pair,
  price: 100_000,
  ind15: set({
    close: 100_000,
    rsi: 60,
    macd: { macd: 50, signal: 30, histogram: 20 },
    bollinger: { upper: 101_000, middle: 99_500, lower: 98_000, widthPct: 3 },
    atr: 400,
    volumeRatio: 1.8,
    ...o15,
  }),
  ind4h: set({
    close: 100_000,
    macd: { macd: 300, signal: 200, histogram: 100 },
    bollinger: { upper: 104_000, middle: 98_000, lower: 92_000, widthPct: 12 },
    ...o4h,
  }),
});

/** A market where mean reversion's conditions all hold (ETH at 3,000, below a narrow lower band). */
const meanRevMarket = (o15: Partial<IndicatorSet> = {}): PairMarket => ({
  pair: "ETH/USDT",
  price: 3_000,
  ind15: set({
    close: 3_000,
    rsi: 24,
    bollinger: { upper: 3_100, middle: 3_050, lower: 3_005, widthPct: 3.1 },
    atr: 15,
    ...o15,
  }),
  ind4h: set({ close: 3_000 }),
});

const account = (o: Partial<Account> = {}): Account => ({ equity: 10_000, cash: 10_000, positions: [], ...o });

const input = (o: Partial<CandidateInput> = {}): CandidateInput => ({
  time: T,
  account: account(),
  markets: {},
  ratio: null,
  strategy: STRATEGY,
  limits: LIMITS,
  ...o,
});

/** BTC 100,000 and ETH 3,000 with neutral indicators (so only stat-arb can fire). */
const ratioMarkets = (): Record<string, PairMarket> => ({
  "BTC/USDT": { pair: "BTC/USDT", price: 100_000, ind15: set({ close: 100_000, atr: 500 }), ind4h: set() },
  "ETH/USDT": { pair: "ETH/USDT", price: 3_000, ind15: set({ close: 3_000, atr: 20 }), ind4h: set() },
});

const withSetting = (file: SettingsFile, key: string, value: unknown) => {
  const r = applySettingChange(file, key, value);
  if (!r.ok) throw new Error(r.reason);
  return r.settings;
};

describe("STR-01 statistical arbitrage on the BTC/ETH ratio", () => {
  it("STR-01 the ratio z-score is (ratio - rolling mean) / rolling standard deviation", () => {
    const btc = [100, 100, 100, 100, 130];
    const eth = [10, 10, 10, 10, 10];
    const z = ratioZSeries(btc, eth, 5);
    // ratios 10,10,10,10,13 -> mean 10.6, population sd 1.2 -> z = (13 - 10.6) / 1.2 = 2
    expect(z.slice(0, 4)).toEqual([null, null, null, null]);
    expect(z[4]!.mean).toBeCloseTo(10.6, 10);
    expect(z[4]!.z).toBeCloseTo(2, 10);
  });

  it("STR-01 a flat ratio has no z-score (not a division by zero)", () => {
    expect(ratioZSeries([100, 100, 100], [10, 10, 10], 3)[2]).toBeNull();
  });

  it("STR-01 no candidate while |z| is below the 2.0 threshold", () => {
    const out = generateCandidates(input({ markets: ratioMarkets(), ratio: { ratio: 33.33, mean: 33.5, z: -1.99 } }));
    expect(out.candidates.filter((c) => c.strategy === "statArb")).toEqual([]);
  });

  it("STR-01 z at -2 or below: BTC is cheap, so buy BTC with a target at the ratio's mean", () => {
    const out = generateCandidates(input({ markets: ratioMarkets(), ratio: { ratio: 33.3333, mean: 34, z: -2.5 } }));
    const c = out.candidates.find((x) => x.strategy === "statArb") as EntryCandidate;
    expect(c).toMatchObject({ pair: "BTC/USDT", direction: "long", entry: 100_000, stop: 99_000, target: 102_000 });
    // target = mean ratio x ETH price = 34 x 3,000; stop = entry - 2 ATR (2 x 500)
    expect(c.rewardToRisk).toBe(2);
  });

  it("STR-01 z at +2 or above: ETH is cheap, so buy ETH with a target at the ratio's mean", () => {
    const out = generateCandidates(input({ markets: ratioMarkets(), ratio: { ratio: 33.3333, mean: 32, z: 2.1 } }));
    const c = out.candidates.find((x) => x.strategy === "statArb") as EntryCandidate;
    // target = BTC price / mean ratio = 100,000 / 32 = 3,125; stop = 3,000 - 2 x 20
    expect(c).toMatchObject({ pair: "ETH/USDT", entry: 3_000, stop: 2_960, target: 3_125 });
  });

  it("STR-01 exits a stat-arb holding when the ratio reverts within 0.5, and only then", () => {
    const held = account({ cash: 7_000, positions: [{ pair: "BTC/USDT", quantity: 0.03, avgEntry: 99_000, strategy: "statArb" }] });
    const notYet = generateCandidates(input({ account: held, markets: ratioMarkets(), ratio: { ratio: 33.3, mean: 33.4, z: -0.6 } }));
    expect(notYet.candidates.filter((c) => c.direction === "exit")).toEqual([]);

    const reverted = generateCandidates(input({ account: held, markets: ratioMarkets(), ratio: { ratio: 33.39, mean: 33.4, z: 0.4 } }));
    expect(reverted.candidates[0]).toMatchObject({ strategy: "statArb", direction: "exit", pair: "BTC/USDT", quantity: 0.03, price: 100_000 });
  });

  it("STR-01 the threshold comes from config and can be changed within its range", () => {
    const stricter = withSetting(STRATEGY, "statArb.zEntry", 3);
    const out = generateCandidates(input({ strategy: stricter, markets: ratioMarkets(), ratio: { ratio: 33.33, mean: 34, z: -2.5 } }));
    expect(out.candidates).toEqual([]);
  });
});

describe("STR-02 momentum needs trend and volume confirmation", () => {
  it("STR-02 all conditions met: a candidate with stop 1.5 ATR below and target 2R above", () => {
    const s = momentumSetup(momentumMarket(), STRATEGY)!;
    expect(s).toMatchObject({ strategy: "momentum", entry: 100_000, stop: 99_400, target: 101_200 });
  });

  it.each([
    ["4h trend down (histogram negative)", {}, { macd: { macd: -1, signal: 1, histogram: -2 } }],
    ["4h price below its middle band", {}, { close: 97_000 }],
    ["15m MACD histogram negative", { macd: { macd: 10, signal: 20, histogram: -10 } }, {}],
    ["15m price below its middle band", { bollinger: { upper: 102_000, middle: 100_500, lower: 99_000, widthPct: 3 } }, {}],
    ["volume only 1.29x average (needs 1.3x)", { volumeRatio: 1.29 }, {}],
    ["RSI 70 (overbought)", { rsi: 70 }, {}],
    ["volume ratio not available yet", { volumeRatio: null }, {}],
    ["ATR not available yet", { atr: null }, {}],
  ])("STR-02 no candidate when %s", (_label, o15, o4h) => {
    expect(momentumSetup(momentumMarket("BTC/USDT", o15 as Partial<IndicatorSet>, o4h as Partial<IndicatorSet>), STRATEGY)).toBeNull();
  });

  it("STR-02 no candidate without 4h data", () => {
    expect(momentumSetup({ ...momentumMarket(), ind4h: null }, STRATEGY)).toBeNull();
  });
});

describe("STR-03 mean reversion only in low volatility", () => {
  it("STR-03 low volatility + below the lower band + RSI under 30: buy, target the middle band", () => {
    expect(meanReversionSetup(meanRevMarket(), STRATEGY)).toMatchObject({
      strategy: "meanReversion",
      entry: 3_000,
      stop: 2_985,
      target: 3_050,
    });
  });

  it.each([
    ["band width 4.01% is not low volatility (limit 4%)", { bollinger: { upper: 3_100, middle: 3_050, lower: 2_978, widthPct: 4.01 } }],
    ["price above the lower band", { bollinger: { upper: 3_100, middle: 3_050, lower: 2_995, widthPct: 3.4 } }],
    ["RSI 31 is not stretched enough", { rsi: 31 }],
    ["RSI not available", { rsi: null }],
  ])("STR-03 no candidate when %s", (_label, o15) => {
    expect(meanReversionSetup(meanRevMarket(o15 as Partial<IndicatorSet>), STRATEGY)).toBeNull();
  });

  it("STR-03 no candidate if the middle band is not above the entry (nothing to gain)", () => {
    expect(meanReversionSetup(meanRevMarket({ bollinger: { upper: 3_010, middle: 2_990, lower: 3_000, widthPct: 0.7 } }), STRATEGY)).toBeNull();
  });
});

describe("STR-04 stops from ATR, targets from the strategy, reward-to-risk", () => {
  it("STR-04 every number on a candidate follows from code: stop = entry - k x ATR, R:R = (target - entry) / (entry - stop)", () => {
    const out = generateCandidates(input({ markets: { "BTC/USDT": momentumMarket() } }));
    const c = out.candidates[0] as EntryCandidate;
    expect(c.entry - c.stop).toBeCloseTo(1.5 * 400, 6);
    expect(c.stopAtr).toBe(1.5);
    expect(c.rewardToRisk).toBe(Number(((c.target - c.entry) / (c.entry - c.stop)).toFixed(2)));
    expect(c.rewardToRisk).toBe(2);
  });

  it("STR-04 mean reversion's R:R is computed from its band target (and can be below 1.5; the validator decides)", () => {
    const out = generateCandidates(input({ markets: { "ETH/USDT": meanRevMarket({ atr: 40 }) } }));
    const c = out.candidates[0] as EntryCandidate;
    // stop = 3,000 - 40 = 2,960; target 3,050 -> R:R = 50 / 40 = 1.25
    expect(c).toMatchObject({ stop: 2_960, target: 3_050, rewardToRisk: 1.25, stopAtr: 1 });
  });

  it("STR-04 candidate IDs are deterministic: same inputs give the same ID", () => {
    const a = generateCandidates(input({ markets: { "BTC/USDT": momentumMarket() } }));
    const b = generateCandidates(input({ markets: { "BTC/USDT": momentumMarket() } }));
    expect(a.candidates[0]!.id).toBe(`momentum-long-BTCUSDT-${T}`);
    expect(a).toEqual(b);
  });
});

describe("STR-05 position size never exceeds risk per trade or the per-asset limit", () => {
  it("STR-05 1% risk: 100 USDT at risk with a 600 USDT stop distance -> 0.166666 BTC... capped by the 25% asset limit", () => {
    const size = sizePosition({ pair: "BTC/USDT", entry: 100_000, stop: 99_400, account: account(), prices: {}, limits: LIMITS });
    // risk sizing alone would buy 100 / 600 = 0.1667 BTC (16,667 USDT); 25% of 10,000 = 2,500 USDT -> 0.025 BTC
    expect(size).toEqual({ ok: true, quantity: 0.025, notional: 2_500, riskAmount: 15, limitedBy: "per-asset limit" });
  });

  it("STR-05 a wide stop is limited by risk per trade: loss at the stop is exactly 1% of equity or less", () => {
    const size = sizePosition({ pair: "ETH/USDT", entry: 3_000, stop: 2_700, account: account(), prices: {}, limits: LIMITS });
    expect(size.ok && size.limitedBy).toBe("risk per trade");
    if (size.ok) {
      expect(size.riskAmount).toBeLessThanOrEqual(100);
      expect(size.riskAmount).toBeGreaterThan(99.99);
    }
  });

  it("STR-05 an existing holding uses up part of the per-asset room", () => {
    const acc = account({ cash: 8_000, positions: [{ pair: "BTC/USDT", quantity: 0.02, avgEntry: 100_000 }] });
    const size = sizePosition({ pair: "BTC/USDT", entry: 100_000, stop: 99_400, account: acc, prices: { "BTC/USDT": 100_000 }, limits: LIMITS });
    expect(size).toMatchObject({ ok: true, quantity: 0.005, notional: 500 });
  });

  it("STR-05 total exposure and cash are limits too (spot never borrows)", () => {
    const fullish = account({
      cash: 4_100,
      positions: [
        { pair: "ETH/USDT", quantity: 1, avgEntry: 2_500 },
        { pair: "SOL/USDT", quantity: 16, avgEntry: 200 },
      ],
    });
    const size = sizePosition({ pair: "BTC/USDT", entry: 100_000, stop: 99_400, account: fullish, prices: {}, limits: LIMITS });
    // exposure 2,500 + 3,200 = 5,700; limit 60% = 6,000 -> room 300 USDT
    expect(size).toMatchObject({ ok: true, notional: 300, limitedBy: "total exposure" });

    const poor = account({ cash: 120 });
    expect(sizePosition({ pair: "BTC/USDT", entry: 100_000, stop: 99_400, account: poor, prices: {}, limits: LIMITS })).toMatchObject({
      ok: true,
      limitedBy: "cash",
    });
  });

  it("STR-05 rounding down to 6 decimals is stable (no floating-point drift)", () => {
    expect(floorQty(0.063439)).toBe(0.063439);
    expect(floorQty(0.0634399)).toBe(0.063439);
    expect(floorQty(floorQty(1 / 3))).toBe(floorQty(1 / 3));
  });

  it("STR-05 an order below the 10 USDT minimum is skipped with a reason", () => {
    const size = sizePosition({ pair: "BTC/USDT", entry: 100_000, stop: 99_400, account: account({ cash: 9 }), prices: {}, limits: LIMITS });
    expect(size).toEqual({ ok: false, reason: expect.stringMatching(/below the 10 USDT minimum \(limited by cash\)/) });
  });

  it("STR-05 a stop at or above the entry is refused", () => {
    expect(sizePosition({ pair: "X", entry: 100, stop: 100, account: account(), prices: {}, limits: LIMITS }).ok).toBe(false);
  });

  it("STR-05 property check: over many random setups, no candidate ever breaks a limit", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 500; i++) {
      const equity = 1_000 + rand() * 50_000;
      const acc = account({ equity, cash: equity * rand() });
      const entry = 10 + rand() * 100_000;
      const stop = entry * (1 - (0.001 + rand() * 0.1));
      const size = sizePosition({ pair: "BTC/USDT", entry, stop, account: acc, prices: {}, limits: LIMITS });
      if (!size.ok) continue;
      expect(size.riskAmount).toBeLessThanOrEqual((equity * LIMITS.riskPerTradeBps) / 10_000 + 1e-6);
      expect(size.notional).toBeLessThanOrEqual((equity * LIMITS.maxAssetBps) / 10_000 + 1e-6);
      expect(size.notional).toBeLessThanOrEqual(acc.cash + 1e-6);
      expect(size.quantity).toBe(floorQty(size.quantity));
    }
  });

  it("STR-05 candidates come out of generateCandidates already sized and pass the risk rules", () => {
    const out = generateCandidates(input({ markets: { "BTC/USDT": momentumMarket() } }));
    const c = out.candidates[0] as EntryCandidate;
    const rules = checkRiskRules(
      c,
      { account: account(), prices: {}, pendingPairs: [], tradesToday: 0, dailyLossLimitHit: false },
      { ...LIMITS, maxTradesPerDay: 10, minRewardToRisk: 1.5, stopAtrMin: 0.5, stopAtrMax: 5 },
    );
    expect(allPassed(rules)).toBe(true);
    expect(rules.map((r) => r.rule)).toEqual([5, 6, 7, 8, 9, 11]);
  });
});

describe("STR-06 nothing when conditions are not met", () => {
  it("STR-06 neutral markets and no ratio signal produce no candidates at all", () => {
    const neutral = { pair: "SOL/USDT", price: 200, ind15: set({ close: 200 }), ind4h: set({ close: 200 }) };
    expect(generateCandidates(input({ markets: { "SOL/USDT": neutral } }))).toEqual({ candidates: [], skipped: [] });
  });

  it("STR-06 no indicators yet (fresh start) means no candidates", () => {
    const empty = { pair: "BTC/USDT", price: 100_000, ind15: null, ind4h: null };
    expect(generateCandidates(input({ markets: { "BTC/USDT": empty }, ratio: null })).candidates).toEqual([]);
  });

  it("STR-06 a disabled strategy produces nothing", () => {
    const off = withSetting(STRATEGY, "momentum.enabled", false);
    expect(generateCandidates(input({ strategy: off, markets: { "BTC/USDT": momentumMarket() } })).candidates).toEqual([]);
  });

  it("STR-06 no new entry in a pair we already hold (skipped with a reason)", () => {
    const acc = account({ cash: 7_500, positions: [{ pair: "BTC/USDT", quantity: 0.025, avgEntry: 99_000 }] });
    const out = generateCandidates(input({ account: acc, markets: { "BTC/USDT": momentumMarket() } }));
    expect(out.candidates).toEqual([]);
    expect(out.skipped).toEqual([{ strategy: "momentum", pair: "BTC/USDT", reason: "Already holding BTC/USDT." }]);
  });
});

describe("STR-07 spot only", () => {
  it("STR-07 an extreme overbought, falling market never produces a short: only long or exit exist", () => {
    const bearish = momentumMarket("BTC/USDT", { rsi: 95, macd: { macd: -90, signal: -10, histogram: -80 } }, {
      macd: { macd: -500, signal: -100, histogram: -400 },
    });
    const out = generateCandidates(input({ markets: { "BTC/USDT": bearish }, ratio: { ratio: 30, mean: 32, z: 3 } }));
    for (const c of out.candidates) expect(["long", "exit"]).toContain(c.direction);
  });

  it("STR-07 'exit' appears only for an asset we hold, and only for stat-arb's own holdings", () => {
    const reverted = { ratio: 33.4, mean: 33.4, z: 0 };
    expect(generateCandidates(input({ markets: ratioMarkets(), ratio: reverted })).candidates).toEqual([]);

    const manual = account({ cash: 9_000, positions: [{ pair: "BTC/USDT", quantity: 0.01, avgEntry: 100_000, strategy: "momentum" }] });
    expect(generateCandidates(input({ account: manual, markets: ratioMarkets(), ratio: reverted })).candidates).toEqual([]);

    const zeroQty = account({ positions: [{ pair: "BTC/USDT", quantity: 0, avgEntry: 100_000, strategy: "statArb" }] });
    expect(generateCandidates(input({ account: zeroQty, markets: ratioMarkets(), ratio: reverted })).candidates).toEqual([]);
  });

  it("STR-07 exits are listed before entries, entries by score", () => {
    const acc = account({ cash: 9_000, positions: [{ pair: "ETH/USDT", quantity: 0.3, avgEntry: 3_000, strategy: "statArb" }] });
    const markets = { ...ratioMarkets(), "SOL/USDT": momentumMarket("SOL/USDT") };
    const out = generateCandidates(input({ account: acc, markets, ratio: { ratio: 33.4, mean: 33.4, z: 0.1 } }));
    expect(out.candidates.map((c) => c.direction)).toEqual(["exit", "long"]);
  });

  it("STR-07 exposure helper counts only real holdings", () => {
    const acc = account({ positions: [{ pair: "BTC/USDT", quantity: 0.01, avgEntry: 90_000 }, { pair: "ETH/USDT", quantity: 0, avgEntry: 1 }] });
    expect(exposureOf(acc, { "BTC/USDT": 100_000 })).toEqual({ total: 1_000, byPair: { "BTC/USDT": 1_000 }, totalBps: 1_000 });
  });
});
