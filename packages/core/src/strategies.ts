// The three strategies from Part 01, as plain rules over code-computed indicators.
// Each produces CANDIDATES with exact numbers: entry, stop (from ATR), target,
// reward-to-risk and a position size inside the risk limits. The AI (phase 4)
// may only pick one of these and explain it; it never invents its own numbers.
//
// Spot only: the only directions are "long" (buy) and "exit" (sell what we hold).
// There is no short selling, no margin and no borrowing.

import { type SettingsFile, num } from "./config/settings.ts";
import { roundPrice } from "./feed/monitor.ts";
import type { IndicatorSet, Series } from "./indicators.ts";
import { type Account, type RiskLimits, sizePosition } from "./risk.ts";

export const STRATEGIES = ["statArb", "momentum", "meanReversion"] as const;
export type StrategyName = (typeof STRATEGIES)[number];

export const STRATEGY_LABELS: Record<StrategyName, string> = {
  statArb: "Statistical arbitrage (BTC/ETH ratio)",
  momentum: "Momentum with strict exits",
  meanReversion: "Mean reversion in low volatility",
};

export type DataPoint = { name: string; value: number };

export type EntryCandidate = {
  id: string;
  strategy: StrategyName;
  pair: string;
  direction: "long";
  entry: number;
  stop: number;
  target: number;
  rewardToRisk: number;
  /** Stop distance measured in ATRs (the validator wants 0.5 to 5). */
  stopAtr: number;
  atr: number;
  quantity: number;
  notional: number;
  riskAmount: number;
  score: number;
  reason: string;
  dataPoints: DataPoint[];
};

export type ExitCandidate = {
  id: string;
  strategy: StrategyName;
  pair: string;
  direction: "exit";
  price: number;
  quantity: number;
  score: number;
  reason: string;
  dataPoints: DataPoint[];
};

export type Candidate = EntryCandidate | ExitCandidate;

/** What code knows about one pair right now. */
export type PairMarket = {
  pair: string;
  price: number;
  ind15: IndicatorSet | null;
  ind4h: IndicatorSet | null;
};

export type RatioStat = { ratio: number; mean: number; z: number };

export type CandidateInput = {
  time: number;
  account: Account;
  markets: Record<string, PairMarket>;
  /** BTC/ETH price ratio z-score, or null if not enough history. */
  ratio: RatioStat | null;
  strategy: SettingsFile;
  limits: RiskLimits;
};

export type Skipped = { strategy: StrategyName; pair: string; reason: string };

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const enabled = (s: SettingsFile, name: StrategyName) => s[`${name}.enabled`]?.value === true;
export const candidateId = (strategy: StrategyName, pair: string, time: number, kind: "long" | "exit" = "long") =>
  `${strategy}-${kind}-${pair.replace("/", "")}-${time}`;

// ---------- the BTC/ETH ratio (for stat-arb) ----------

/**
 * Rolling z-score of the BTC/ETH price ratio: how many standard deviations
 * today's ratio is from its average over the last `lookback` candles
 * (the window includes the current candle). Null until a full window exists.
 */
export function ratioZSeries(btcCloses: readonly number[], ethCloses: readonly number[], lookback: number): Series<RatioStat> {
  const n = Math.min(btcCloses.length, ethCloses.length);
  const out: Series<RatioStat> = new Array(n).fill(null);
  let sum = 0;
  let sumSq = 0;
  const ratios: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = btcCloses[i]! / ethCloses[i]!;
    ratios.push(r);
    sum += r;
    sumSq += r * r;
    if (i >= lookback) {
      const old = ratios[i - lookback]!;
      sum -= old;
      sumSq -= old * old;
    }
    if (i >= lookback - 1) {
      const mean = sum / lookback;
      const variance = Math.max(0, sumSq / lookback - mean * mean);
      const sd = Math.sqrt(variance);
      out[i] = sd > 1e-12 ? { ratio: r, mean, z: (r - mean) / sd } : null;
    }
  }
  return out;
}

// ---------- setups (prices only; sizing comes after) ----------

type Setup = Omit<EntryCandidate, "id" | "quantity" | "notional" | "riskAmount" | "direction" | "rewardToRisk" | "stopAtr">;

/** Momentum: trend on 4h and 15m, confirmed by volume, not already overbought. */
export function momentumSetup(m: PairMarket, s: SettingsFile): Setup | null {
  const a = m.ind15;
  const b = m.ind4h;
  if (!a?.macd || !a.bollinger || !a.atr || a.volumeRatio === null || a.rsi === null) return null;
  if (!b?.macd || !b.bollinger) return null;

  const trendUp4h = b.macd.histogram > 0 && b.close > b.bollinger.middle;
  const trendUp15 = a.macd.histogram > 0 && m.price > a.bollinger.middle;
  const volumeOk = a.volumeRatio >= num(s, "momentum.minVolumeRatio");
  const notOverbought = a.rsi < num(s, "momentum.maxRsi");
  if (!trendUp4h || !trendUp15 || !volumeOk || !notOverbought) return null;

  const entry = roundPrice(m.price);
  const stop = roundPrice(entry - num(s, "momentum.stopAtr") * a.atr);
  const target = roundPrice(entry + num(s, "momentum.targetR") * (entry - stop));
  return {
    strategy: "momentum",
    pair: m.pair,
    entry,
    stop,
    target,
    atr: a.atr,
    score: clamp01((a.volumeRatio - 1) / 2),
    reason: `${m.pair} is trending up on 4h and 15m with volume ${r2(a.volumeRatio)}x its 30-day average.`,
    dataPoints: [
      { name: `${m.pair} price`, value: entry },
      { name: `${m.pair} 15m RSI`, value: r2(a.rsi) },
      { name: `${m.pair} 15m volume vs 30d avg`, value: r2(a.volumeRatio) },
      { name: `${m.pair} 4h MACD histogram`, value: r2(b.macd.histogram) },
      { name: `${m.pair} 15m ATR`, value: roundPrice(a.atr) },
    ],
  };
}

/** Mean reversion: only in low volatility, price stretched below the lower band, RSI low. */
export function meanReversionSetup(m: PairMarket, s: SettingsFile): Setup | null {
  const a = m.ind15;
  if (!a?.bollinger || !a.atr || a.rsi === null) return null;

  const lowVol = a.bollinger.widthPct <= num(s, "meanReversion.maxBandWidthPct");
  const stretched = m.price <= a.bollinger.lower && a.rsi <= num(s, "meanReversion.rsiEntry");
  if (!lowVol || !stretched) return null;

  const entry = roundPrice(m.price);
  const stop = roundPrice(entry - num(s, "meanReversion.stopAtr") * a.atr);
  const target = roundPrice(a.bollinger.middle); // back to the average
  if (target <= entry) return null;
  return {
    strategy: "meanReversion",
    pair: m.pair,
    entry,
    stop,
    target,
    atr: a.atr,
    score: clamp01((num(s, "meanReversion.rsiEntry") - a.rsi) / 20 + 0.5),
    reason: `${m.pair} is below its lower Bollinger band with RSI ${r2(a.rsi)} while volatility is low (band width ${r2(a.bollinger.widthPct)}%).`,
    dataPoints: [
      { name: `${m.pair} price`, value: entry },
      { name: `${m.pair} 15m RSI`, value: r2(a.rsi) },
      { name: `${m.pair} 15m Bollinger lower`, value: roundPrice(a.bollinger.lower) },
      { name: `${m.pair} 15m Bollinger middle`, value: target },
      { name: `${m.pair} 15m band width %`, value: r2(a.bollinger.widthPct) },
      { name: `${m.pair} 15m ATR`, value: roundPrice(a.atr) },
    ],
  };
}

/** Stat-arb: when the BTC/ETH ratio is stretched, buy the cheap side and target the ratio's return to its mean. */
export function statArbSetup(input: CandidateInput): Setup | null {
  const { ratio, markets, strategy: s } = input;
  const btc = markets["BTC/USDT"];
  const eth = markets["ETH/USDT"];
  if (!ratio || !btc || !eth) return null;
  const zEntry = num(s, "statArb.zEntry");
  if (Math.abs(ratio.z) < zEntry) return null;

  // z below -zEntry: BTC is cheap relative to ETH. Above +zEntry: ETH is cheap.
  const buyBtc = ratio.z <= -zEntry;
  const leg = buyBtc ? btc : eth;
  if (!leg.ind15?.atr) return null;
  const entry = roundPrice(leg.price);
  const stop = roundPrice(entry - num(s, "statArb.stopAtr") * leg.ind15.atr);
  // Target: the price this leg would have if the ratio returned to its mean, the other leg unchanged.
  const target = roundPrice(buyBtc ? ratio.mean * eth.price : btc.price / ratio.mean);
  if (target <= entry) return null;
  return {
    strategy: "statArb",
    pair: leg.pair,
    entry,
    stop,
    target,
    atr: leg.ind15.atr,
    score: clamp01((Math.abs(ratio.z) - zEntry) / 2 + 0.5),
    reason: `The BTC/ETH ratio is ${r2(ratio.z)} standard deviations from its average, so ${leg.pair} looks cheap relative to the other.`,
    dataPoints: [
      { name: "BTC/ETH ratio z-score", value: r2(ratio.z) },
      { name: "BTC/ETH ratio", value: Number(ratio.ratio.toFixed(4)) },
      { name: "BTC/ETH ratio average", value: Number(ratio.mean.toFixed(4)) },
      { name: `${leg.pair} price`, value: entry },
      { name: `${leg.pair} 15m ATR`, value: roundPrice(leg.ind15.atr) },
    ],
  };
}

/** Stat-arb exits: when the ratio has come back near its mean, sell what stat-arb bought. */
export function statArbExits(input: CandidateInput): ExitCandidate[] {
  const { ratio, account, markets, strategy: s, time } = input;
  if (!ratio || Math.abs(ratio.z) > num(s, "statArb.zExit")) return [];
  return account.positions
    .filter((p) => p.strategy === "statArb" && p.quantity > 0 && markets[p.pair])
    .map((p) => ({
      id: candidateId("statArb", p.pair, time, "exit"),
      strategy: "statArb" as const,
      pair: p.pair,
      direction: "exit" as const,
      price: roundPrice(markets[p.pair]!.price),
      quantity: p.quantity,
      score: 1,
      reason: `The BTC/ETH ratio is back within ${num(s, "statArb.zExit")} standard deviations of its average: the gap has closed.`,
      dataPoints: [
        { name: "BTC/ETH ratio z-score", value: r2(ratio.z) },
        { name: `${p.pair} price`, value: roundPrice(markets[p.pair]!.price) },
      ],
    }));
}

/**
 * All candidates right now, sized and ready. Also returns what was skipped and why
 * (for the UI and, later, so the AI can say "no candidate because ...").
 * Rules applied here:
 *  - disabled strategies produce nothing
 *  - no new entry in a pair we already hold
 *  - exits only for assets we actually hold
 */
export function generateCandidates(input: CandidateInput): { candidates: Candidate[]; skipped: Skipped[] } {
  const { account, markets, strategy: s, limits, time } = input;
  const held = new Set(account.positions.filter((p) => p.quantity > 0).map((p) => p.pair));
  const prices = Object.fromEntries(Object.values(markets).map((m) => [m.pair, m.price]));

  const setups: Setup[] = [];
  if (enabled(s, "statArb")) {
    const sa = statArbSetup(input);
    if (sa) setups.push(sa);
  }
  for (const m of Object.values(markets)) {
    if (enabled(s, "momentum")) {
      const mo = momentumSetup(m, s);
      if (mo) setups.push(mo);
    }
    if (enabled(s, "meanReversion")) {
      const mr = meanReversionSetup(m, s);
      if (mr) setups.push(mr);
    }
  }

  const candidates: Candidate[] = enabled(s, "statArb") ? statArbExits(input) : [];
  const skipped: Skipped[] = [];
  for (const setup of setups) {
    if (held.has(setup.pair)) {
      skipped.push({ strategy: setup.strategy, pair: setup.pair, reason: `Already holding ${setup.pair}.` });
      continue;
    }
    const size = sizePosition({ pair: setup.pair, entry: setup.entry, stop: setup.stop, account, prices, limits });
    if (!size.ok) {
      skipped.push({ strategy: setup.strategy, pair: setup.pair, reason: size.reason });
      continue;
    }
    candidates.push({
      ...setup,
      id: candidateId(setup.strategy, setup.pair, time),
      direction: "long",
      rewardToRisk: r2((setup.target - setup.entry) / (setup.entry - setup.stop)),
      stopAtr: r2((setup.entry - setup.stop) / setup.atr),
      quantity: size.quantity,
      notional: r2(size.notional),
      riskAmount: r2(size.riskAmount),
    });
  }
  // Exits first, then the strongest setups.
  candidates.sort((a, b) => (a.direction === b.direction ? b.score - a.score : a.direction === "exit" ? -1 : 1));
  return { candidates, skipped };
}
