import { describe, expect, it } from "vitest";
import {
  CandleAggregator,
  type Candle,
  MAX_FLAT_FILL_MINUTES,
  bucketStart,
  findGaps,
  loadCandles,
  rollup,
  rollupMinute,
  upsertCandle,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

// 2026-01-01 00:00:00 UTC: aligned to the minute, 15 minutes and 4 hours.
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
const PAIR = "BTC/USDT";

const tick = (offsetMs: number, price: number, quantity: number, tradeId?: number) => ({
  pair: PAIR,
  price,
  quantity,
  timeMs: T0 + offsetMs,
  tradeId,
});

const c1m = (minute: number, o: number, h: number, l: number, c: number, v: number): Candle => ({
  pair: PAIR,
  timeframe: "1m",
  openTimeMs: T0 + minute * MIN,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: v,
});

describe("FEED-01 ticks to 1m candles", () => {
  it("FEED-01 builds the exact OHLCV of each minute from a known tick fixture", () => {
    const agg = new CandleAggregator();
    const closed: Candle[] = [];
    for (const t of [
      tick(1_000, 100, 1),
      tick(20_000, 105, 2),
      tick(40_000, 98, 1),
      tick(59_999, 101, 0.5),
      tick(60_000, 102, 1), // first tick of minute 1 closes minute 0
      tick(90_000, 99, 1),
      tick(2 * MIN + 5_000, 103, 4), // closes minute 1
    ]) {
      closed.push(...agg.addTick(t).closed);
    }
    expect(closed).toEqual([c1m(0, 100, 105, 98, 101, 4.5), c1m(1, 102, 102, 99, 99, 2)]);
    expect(agg.currentCandle(PAIR)).toEqual(c1m(2, 103, 103, 103, 103, 4));
  });

  it("FEED-01 a quiet minute becomes a flat zero-volume candle at the previous close", () => {
    const agg = new CandleAggregator();
    agg.addTick(tick(1_000, 100, 1));
    agg.addTick(tick(30_000, 101, 1));
    const closed = agg.addTick(tick(3 * MIN + 1_000, 104, 2)).closed;
    expect(closed).toEqual([c1m(0, 100, 101, 100, 101, 2), c1m(1, 101, 101, 101, 101, 0), c1m(2, 101, 101, 101, 101, 0)]);
    expect(agg.currentCandle(PAIR)).toEqual(c1m(3, 104, 104, 104, 104, 2));
  });

  it("FEED-01 closeIfDue closes a minute on time even when no new trade arrives", () => {
    const agg = new CandleAggregator();
    agg.addTick(tick(5_000, 100, 1));
    expect(agg.closeIfDue(PAIR, T0 + 59_000)).toEqual([]);
    expect(agg.closeIfDue(PAIR, T0 + MIN + 10)).toEqual([c1m(0, 100, 100, 100, 100, 1)]);
    // The next minute starts as a placeholder; its first trade sets the real open.
    agg.addTick(tick(MIN + 20_000, 107, 1));
    expect(agg.currentCandle(PAIR)).toEqual(c1m(1, 107, 107, 107, 107, 1));
    expect(agg.closeIfDue("ETH/USDT", T0 + 5 * MIN)).toEqual([]); // unknown pair: nothing to close
  });

  it("FEED-01 a silence longer than an hour is left as a gap, not filled with flat candles", () => {
    const agg = new CandleAggregator();
    agg.addTick(tick(0, 100, 1));
    const closed = agg.addTick(tick((MAX_FLAT_FILL_MINUTES + 5) * MIN, 120, 1)).closed;
    expect(closed).toEqual([c1m(0, 100, 100, 100, 100, 1)]);
  });

  it("FEED-01 ignores nonsense ticks (zero or negative price, negative quantity, NaN)", () => {
    const agg = new CandleAggregator();
    expect(agg.addTick(tick(0, 0, 1)).ignored).toBe(true);
    expect(agg.addTick(tick(0, -5, 1)).ignored).toBe(true);
    expect(agg.addTick(tick(0, 100, -1)).ignored).toBe(true);
    expect(agg.addTick(tick(0, Number.NaN, 1)).ignored).toBe(true);
    expect(agg.currentCandle(PAIR)).toBeNull();
  });

  it("FEED-01 a late tick for an already-closed minute is ignored", () => {
    const agg = new CandleAggregator();
    agg.addTick(tick(1_000, 100, 1));
    agg.addTick(tick(MIN + 1_000, 101, 1));
    expect(agg.addTick(tick(30_000, 500, 9)).ignored).toBe(true);
    expect(agg.currentCandle(PAIR)?.high).toBe(101);
  });
});

describe("FEED-01 1m candles into 15m and 4h", () => {
  // Fixture: minutes 0..14 make the first 15m bucket, 15..29 the second; all inside the first 4h bucket.
  const minutes: Candle[] = [];
  for (let m = 0; m < 30; m++) {
    const base = 100 + m;
    minutes.push(c1m(m, base, base + 2, base - 1, base + 1, 1 + m / 10));
  }

  it("FEED-01 rolls 1m into 15m with first open, max high, min low, last close and summed volume", () => {
    const [first, second] = rollup(minutes, "15m");
    expect(first).toEqual({ pair: PAIR, timeframe: "15m", openTimeMs: T0, open: 100, high: 116, low: 99, close: 115, volume: 25.5 });
    expect(second).toEqual({
      pair: PAIR,
      timeframe: "15m",
      openTimeMs: T0 + 15 * MIN,
      open: 115,
      high: 131,
      low: 114,
      close: 130,
      volume: 48,
    });
  });

  it("FEED-01 rolls 1m into 4h, and input order does not matter", () => {
    const shuffled = [...minutes].reverse();
    expect(rollup(shuffled, "4h")).toEqual([
      { pair: PAIR, timeframe: "4h", openTimeMs: T0, open: 100, high: 131, low: 99, close: 130, volume: expect.closeTo(73.5, 9) },
    ]);
  });

  it("FEED-01 bucket boundaries are aligned to UTC", () => {
    expect(bucketStart(T0 + 4 * 60 * MIN - 1, "4h")).toBe(T0);
    expect(bucketStart(T0 + 4 * 60 * MIN, "4h")).toBe(T0 + 4 * 60 * MIN);
    expect(bucketStart(T0 + 14 * MIN + 59_999, "15m")).toBe(T0);
  });

  it("FEED-01 storing closed minutes rebuilds the stored 15m and 4h candles", () => {
    const { db } = tempDb();
    for (const c of minutes.slice(0, 16)) {
      upsertCandle(db, "src", c);
      rollupMinute(db, "src", PAIR, c.openTimeMs);
    }
    const m15 = loadCandles(db, "src", PAIR, "15m", T0, T0 + 30 * MIN);
    expect(m15).toEqual([
      { pair: PAIR, timeframe: "15m", openTimeMs: T0, open: 100, high: 116, low: 99, close: 115, volume: 25.5 },
      { pair: PAIR, timeframe: "15m", openTimeMs: T0 + 15 * MIN, open: 115, high: 117, low: 114, close: 116, volume: 2.5 },
    ]);
    const h4 = loadCandles(db, "src", PAIR, "4h", T0, T0 + 1);
    expect(h4[0]).toMatchObject({ open: 100, high: 117, low: 99, close: 116 });
  });

  it("FEED-01 a partial run of minutes never overwrites a correct higher-timeframe candle", () => {
    const { db } = tempDb();
    const fromRest: Candle = { pair: PAIR, timeframe: "15m", openTimeMs: T0, open: 1, high: 9, low: 1, close: 5, volume: 100 };
    upsertCandle(db, "src", fromRest);
    // Only minute 7 of the bucket is known locally (minutes 0..6 missing).
    upsertCandle(db, "src", c1m(7, 50, 50, 50, 50, 1));
    rollupMinute(db, "src", PAIR, T0 + 7 * MIN);
    expect(loadCandles(db, "src", PAIR, "15m", T0, T0 + 1)).toEqual([fromRest]);
  });
});

describe("FEED-08 gap detection", () => {
  it("FEED-08 finds missing candles as contiguous ranges", () => {
    const have = [0, 1, 4, 5, 9].map((m) => T0 + m * MIN);
    expect(findGaps(have, "1m", T0, T0 + 10 * MIN)).toEqual([
      { startMs: T0 + 2 * MIN, endMs: T0 + 4 * MIN, missing: 2 },
      { startMs: T0 + 6 * MIN, endMs: T0 + 9 * MIN, missing: 3 },
    ]);
  });

  it("FEED-08 reports no gaps when nothing is missing, and a full gap when everything is", () => {
    const all = Array.from({ length: 10 }, (_, m) => T0 + m * MIN);
    expect(findGaps(all, "1m", T0, T0 + 10 * MIN)).toEqual([]);
    expect(findGaps([], "15m", T0, T0 + 60 * MIN)).toEqual([{ startMs: T0, endMs: T0 + 60 * MIN, missing: 4 }]);
  });
});
