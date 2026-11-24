// The snapshot: everything the AI is allowed to see, computed by code.
//
// It holds prices, indicators (15m and 4h), the BTC/ETH ratio, the account,
// today's numbers, the active strategy settings, the code-computed CANDIDATES,
// and a flat list of FACTS: the exact {name, value} pairs the AI may cite.
// Every number is rounded once, here, so the AI copies short exact values
// and the guardrails can compare them exactly.
//
// The snapshot is hashed (SHA-256 of canonical JSON) and stored, so any
// signal can be traced back to precisely what the AI saw.

import { type SettingsFile, num } from "../config/settings.ts";
import type { Db } from "../db/db.ts";
import type { Candle } from "../feed/candles.ts";
import { roundNum, roundPrice } from "../feed/monitor.ts";
import { FEED_SOURCE } from "../feed/service.ts";
import { latestCandles } from "../feed/store.ts";
import { type IndicatorSet, indicatorTable, indicatorsAt, candlesPerDays } from "../indicators.ts";
import { type Account, type RiskLimits, exposureOf, riskLimitsFrom } from "../risk.ts";
import {
  type Candidate,
  type DataPoint,
  type PairMarket,
  type Skipped,
  STRATEGY_LABELS,
  generateCandidates,
  ratioZSeries,
} from "../strategies.ts";
import { canonicalJson, sha256 } from "../util/canonical.ts";

const r2 = (x: number) => Math.round(x * 100) / 100;
const opt = (x: number | null | undefined, f: (n: number) => number) => (x === null || x === undefined ? null : f(x));

export type IndicatorView = {
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bollingerUpper: number | null;
  bollingerMiddle: number | null;
  bollingerLower: number | null;
  bandWidthPct: number | null;
  atr: number | null;
  volumeRatio: number | null;
};

export type SnapshotPair = {
  pair: string;
  price: { last: number; bid: number | null; ask: number | null; change24hPct: number | null; volume24h: number | null };
  m15: IndicatorView | null;
  h4: IndicatorView | null;
};

export type Snapshot = {
  version: 1;
  createdAt: string;
  mode: string;
  pairs: SnapshotPair[];
  ratio: { z: number; ratio: number; mean: number } | null;
  account: {
    equity: number;
    cash: number;
    exposurePct: number;
    positions: { pair: string; quantity: number; avgEntry: number; value: number; unrealisedPnl: number }[];
  };
  today: { trades: number; pnl: number; dailyLossLimitUsdt: number; dailyLossUsedPct: number };
  strategy: Record<string, number | boolean | string | string[]>;
  candidates: Candidate[];
  skipped: Skipped[];
  facts: DataPoint[];
};

export type PriceRow = { last: number | null; bid: number | null; ask: number | null; change24hPct: number | null; volume24h: number | null };

export type SnapshotInputs = {
  nowMs: number;
  mode: string;
  pairs: string[];
  prices: Record<string, PriceRow | undefined>;
  candles15: Record<string, Candle[]>;
  candles4h: Record<string, Candle[]>;
  account: Account;
  today: { trades: number; pnl: number; dayStartEquity: number };
  strategy: SettingsFile;
  risk: SettingsFile;
};

function view(set: IndicatorSet | null): IndicatorView | null {
  if (!set) return null;
  return {
    rsi: opt(set.rsi, r2),
    macd: opt(set.macd?.macd, roundNum),
    macdSignal: opt(set.macd?.signal, roundNum),
    macdHistogram: opt(set.macd?.histogram, roundNum),
    bollingerUpper: opt(set.bollinger?.upper, roundPrice),
    bollingerMiddle: opt(set.bollinger?.middle, roundPrice),
    bollingerLower: opt(set.bollinger?.lower, roundPrice),
    bandWidthPct: opt(set.bollinger?.widthPct, r2),
    atr: opt(set.atr, roundPrice),
    volumeRatio: opt(set.volumeRatio, r2),
  };
}

/** Facts the AI may cite, by exact name. Built from the same rounded values the snapshot shows. */
function buildFacts(s: Omit<Snapshot, "facts">): DataPoint[] {
  const facts: DataPoint[] = [];
  const seen = new Map<string, number>();
  const add = (name: string, value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const prev = seen.get(name);
    if (prev !== undefined) {
      // Two different values under one name would make grounding ambiguous: that's a bug in our code.
      if (prev !== value) throw new Error(`Fact "${name}" has two values: ${prev} and ${value}`);
      return;
    }
    seen.set(name, value);
    facts.push({ name, value });
  };

  for (const p of s.pairs) {
    add(`${p.pair} price`, p.price.last);
    add(`${p.pair} 24h change %`, p.price.change24hPct);
    if (p.m15) {
      add(`${p.pair} 15m RSI`, p.m15.rsi);
      add(`${p.pair} 15m MACD histogram`, p.m15.macdHistogram);
      add(`${p.pair} 15m Bollinger upper`, p.m15.bollingerUpper);
      add(`${p.pair} 15m Bollinger middle`, p.m15.bollingerMiddle);
      add(`${p.pair} 15m Bollinger lower`, p.m15.bollingerLower);
      add(`${p.pair} 15m band width %`, p.m15.bandWidthPct);
      add(`${p.pair} 15m ATR`, p.m15.atr);
      add(`${p.pair} 15m volume vs 30d avg`, p.m15.volumeRatio);
    }
    if (p.h4) {
      add(`${p.pair} 4h RSI`, p.h4.rsi);
      add(`${p.pair} 4h MACD histogram`, p.h4.macdHistogram);
      add(`${p.pair} 4h Bollinger middle`, p.h4.bollingerMiddle);
    }
  }
  if (s.ratio) {
    add("BTC/ETH ratio z-score", s.ratio.z);
    add("BTC/ETH ratio", s.ratio.ratio);
    add("BTC/ETH ratio average", s.ratio.mean);
  }
  add("Equity USDT", s.account.equity);
  add("Cash USDT", s.account.cash);
  add("Exposure %", s.account.exposurePct);
  add("Trades today", s.today.trades);
  add("P&L today USDT", s.today.pnl);
  add("Daily loss limit used %", s.today.dailyLossUsedPct);

  for (const c of s.candidates) {
    for (const dp of c.dataPoints) add(dp.name, dp.value);
    const tag = `${c.strategy} ${c.pair}`;
    if (c.direction === "long") {
      add(`${tag} entry`, c.entry);
      add(`${tag} stop`, c.stop);
      add(`${tag} target`, c.target);
      add(`${tag} reward-to-risk`, c.rewardToRisk);
      add(`${tag} size USDT`, c.notional);
      add(`${tag} risk USDT`, c.riskAmount);
    } else {
      add(`${tag} exit price`, c.price);
    }
  }
  return facts;
}

/** Pure: builds the snapshot from inputs that were already read. */
export function buildSnapshot(inp: SnapshotInputs): Snapshot {
  const { pairs, strategy, risk } = inp;
  const markets: Record<string, PairMarket> = {};
  const snapshotPairs: SnapshotPair[] = [];

  for (const pair of pairs) {
    const c15 = inp.candles15[pair] ?? [];
    const c4h = inp.candles4h[pair] ?? [];
    const row = inp.prices[pair];
    const last = row?.last ?? c15.at(-1)?.close;
    if (last === undefined || last === null) continue; // no price at all: leave the pair out
    const ind15 = c15.length ? indicatorsAt(indicatorTable(c15, "15m"), c15.length - 1) : null;
    const ind4h = c4h.length ? indicatorsAt(indicatorTable(c4h, "4h"), c4h.length - 1) : null;
    const price = roundPrice(last);
    markets[pair] = { pair, price, ind15, ind4h };
    snapshotPairs.push({
      pair,
      price: {
        last: price,
        bid: opt(row?.bid, roundPrice),
        ask: opt(row?.ask, roundPrice),
        change24hPct: opt(row?.change24hPct, r2),
        volume24h: opt(row?.volume24h, r2),
      },
      m15: view(ind15),
      h4: view(ind4h),
    });
  }

  // BTC/ETH ratio z-score on the 15m closes both pairs share.
  let ratio: Snapshot["ratio"] = null;
  const btc = inp.candles15["BTC/USDT"];
  const eth = inp.candles15["ETH/USDT"];
  if (btc?.length && eth?.length) {
    const ethByTime = new Map(eth.map((c) => [c.openTimeMs, c.close]));
    const common = btc.filter((c) => ethByTime.has(c.openTimeMs));
    const z = ratioZSeries(common.map((c) => c.close), common.map((c) => ethByTime.get(c.openTimeMs)!), num(strategy, "statArb.lookbackCandles"));
    const lastZ = z.at(-1);
    if (lastZ) ratio = { z: r2(lastZ.z), ratio: Number(lastZ.ratio.toFixed(4)), mean: Number(lastZ.mean.toFixed(4)) };
  }

  const limits: RiskLimits = riskLimitsFrom(risk);
  const prices = Object.fromEntries(Object.values(markets).map((m) => [m.pair, m.price]));
  const { candidates, skipped } = generateCandidates({
    time: inp.nowMs,
    account: inp.account,
    markets,
    ratio: ratio ? { z: ratio.z, ratio: ratio.ratio, mean: ratio.mean } : null,
    strategy,
    limits,
  });

  const exp = exposureOf(inp.account, prices);
  const dailyLimitUsdt = r2((inp.today.dayStartEquity * num(risk, "dailyLossLimitBps")) / 10_000);
  const lossToday = Math.max(0, -inp.today.pnl);

  const base: Omit<Snapshot, "facts"> = {
    version: 1,
    createdAt: new Date(inp.nowMs).toISOString(),
    mode: inp.mode,
    pairs: snapshotPairs,
    ratio,
    account: {
      equity: r2(inp.account.equity),
      cash: r2(inp.account.cash),
      exposurePct: r2(exp.totalBps / 100),
      positions: inp.account.positions
        .filter((p) => p.quantity > 0)
        .map((p) => {
          const px = prices[p.pair] ?? p.avgEntry;
          return { pair: p.pair, quantity: p.quantity, avgEntry: roundPrice(p.avgEntry), value: r2(p.quantity * px), unrealisedPnl: r2(p.quantity * (px - p.avgEntry)) };
        }),
    },
    today: {
      trades: inp.today.trades,
      pnl: r2(inp.today.pnl),
      dailyLossLimitUsdt: dailyLimitUsdt,
      dailyLossUsedPct: dailyLimitUsdt > 0 ? r2((lossToday / dailyLimitUsdt) * 100) : 0,
    },
    strategy: Object.fromEntries(Object.entries(strategy).map(([k, v]) => [k, v.value])),
    candidates,
    skipped,
  };
  return { ...base, facts: buildFacts(base) };
}

export const snapshotHash = (s: Snapshot): string => sha256(canonicalJson(s));

/** Stores a snapshot under its hash. Storing the same snapshot twice is a no-op. */
export function storeSnapshot(db: Db, s: Snapshot): string {
  const hash = snapshotHash(s);
  db.prepare("INSERT OR IGNORE INTO snapshots (hash, created_at, json) VALUES (?, ?, ?)").run(hash, s.createdAt, canonicalJson(s));
  return hash;
}

export function loadSnapshot(db: Db, hash: string): Snapshot | null {
  const row = db.prepare("SELECT json FROM snapshots WHERE hash = ?").get(hash) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Snapshot) : null;
}

// ---------- reading the inputs from the database (read-only queries) ----------

const DAY = 86_400_000;

/** Reads everything buildSnapshot needs. Only SELECTs, so it works on a read-only connection. */
export function readSnapshotInputs(db: Db, opts: { nowMs: number; mode: string; strategy: SettingsFile; risk: SettingsFile }): SnapshotInputs {
  const pairs = opts.strategy.pairs!.value as string[];
  const prices: Record<string, PriceRow> = {};
  const rows = db.prepare("SELECT pair, last, bid, ask, change_24h_pct, volume_24h FROM price_state").all() as {
    pair: string;
    last: number | null;
    bid: number | null;
    ask: number | null;
    change_24h_pct: number | null;
    volume_24h: number | null;
  }[];
  for (const r of rows) prices[r.pair] = { last: r.last, bid: r.bid, ask: r.ask, change24hPct: r.change_24h_pct, volume24h: r.volume_24h };

  // Enough 15m history for the 30-day volume average (+ a margin), and enough 4h for MACD.
  const need15 = candlesPerDays("15m", 30) + 60;
  const candles15: Record<string, Candle[]> = {};
  const candles4h: Record<string, Candle[]> = {};
  for (const pair of pairs) {
    // Only CLOSED candles: the one still forming would change under the AI's feet.
    candles15[pair] = latestCandles(db, FEED_SOURCE, pair, "15m", need15 + 1).filter((c) => c.openTimeMs + 900_000 <= opts.nowMs);
    candles4h[pair] = latestCandles(db, FEED_SOURCE, pair, "4h", 250).filter((c) => c.openTimeMs + 4 * 3_600_000 <= opts.nowMs);
  }

  const eq = db.prepare("SELECT equity, cash, day_start_equity FROM equity_snapshots ORDER BY id DESC LIMIT 1").get() as
    | { equity: number; cash: number; day_start_equity: number }
    | undefined;
  const positions = (
    db.prepare("SELECT pair, quantity, avg_entry FROM positions WHERE status = 'open'").all() as { pair: string; quantity: number; avg_entry: number }[]
  ).map((p) => ({ pair: p.pair, quantity: p.quantity, avgEntry: p.avg_entry }));

  const dayStart = new Date(Math.floor(opts.nowMs / DAY) * DAY).toISOString();
  const trades = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE side = 'buy' AND created_at >= ?").get(dayStart) as { n: number }).n;
  const realised = (db.prepare("SELECT COALESCE(SUM(realised_pnl), 0) AS p FROM positions WHERE closed_at >= ?").get(dayStart) as { p: number }).p;
  const equity = eq?.equity ?? 0;
  return {
    nowMs: opts.nowMs,
    mode: opts.mode,
    pairs,
    prices,
    candles15,
    candles4h,
    account: { equity, cash: eq?.cash ?? 0, positions },
    today: { trades, pnl: realised, dayStartEquity: eq?.day_start_equity ?? equity },
    strategy: opts.strategy,
    risk: opts.risk,
  };
}

export const strategyLabel = (s: string) => STRATEGY_LABELS[s as keyof typeof STRATEGY_LABELS] ?? s;
