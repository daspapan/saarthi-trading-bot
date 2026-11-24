// Building candles: ticks -> 1m candles -> 15m and 4h candles.
// Everything here is pure (no database, no clock), so it is easy to test with
// a fixture of known ticks.

export const TIMEFRAMES = {
  "1m": 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;

/** The higher timeframes we build live from closed 1m candles. */
export const ROLLUP_TIMEFRAMES: readonly Timeframe[] = ["15m", "4h"];

export type Tick = {
  pair: string;
  price: number;
  quantity: number;
  timeMs: number;
  /** Exchange trade ID. Binance IDs only go up, which lets us drop repeats. */
  tradeId?: number;
};

export type Candle = {
  pair: string;
  timeframe: Timeframe;
  openTimeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Start of the bucket a timestamp falls into (UTC, aligned to the epoch). */
export function bucketStart(timeMs: number, timeframe: Timeframe): number {
  const size = TIMEFRAMES[timeframe];
  return Math.floor(timeMs / size) * size;
}

export type TickResult = {
  /** Minutes that finished because of this tick (normally 0 or 1). */
  closed: Candle[];
  /** True if the tick was ignored (a repeat, too old, or nonsense). */
  ignored: boolean;
};

/**
 * Longest quiet spell we fill with flat candles. Anything longer is not a
 * quiet market but missing data, and is left as a gap for the REST backfill.
 */
export const MAX_FLAT_FILL_MINUTES = 60;

/**
 * Turns a stream of ticks for many pairs into 1m candles.
 *
 * - Repeated trades (same or lower trade ID, e.g. replayed after a reconnect)
 *   and ticks for an already-closed minute are ignored, so nothing counts twice.
 * - A minute with no trades while we are connected becomes a flat candle
 *   (open = high = low = close = previous close, volume 0), like Binance's own klines.
 * - reset() forgets the minute in progress. Call it when the socket drops, so a
 *   disconnect leaves a real gap for the backfill instead of fake flat candles.
 */
export class CandleAggregator {
  private current = new Map<string, Candle>();
  private traded = new Map<string, boolean>();
  private lastTradeId = new Map<string, number>();

  addTick(tick: Tick): TickResult {
    if (!Number.isFinite(tick.price) || tick.price <= 0 || !Number.isFinite(tick.quantity) || tick.quantity < 0) {
      return { closed: [], ignored: true };
    }
    if (tick.tradeId !== undefined) {
      const last = this.lastTradeId.get(tick.pair);
      if (last !== undefined && tick.tradeId <= last) return { closed: [], ignored: true };
      this.lastTradeId.set(tick.pair, tick.tradeId);
    }

    const minute = bucketStart(tick.timeMs, "1m");
    const existing = this.current.get(tick.pair);

    if (!existing) {
      this.startMinute(tick.pair, minute, tick.price, tick.quantity, true);
      return { closed: [], ignored: false };
    }
    if (minute < existing.openTimeMs) return { closed: [], ignored: true }; // late tick for a closed minute

    const closed = minute > existing.openTimeMs ? this.advance(tick.pair, minute) : [];
    const c = this.current.get(tick.pair)!;
    if (!this.traded.get(tick.pair)) {
      // First real trade of a minute that started as a flat placeholder.
      c.open = c.high = c.low = c.close = tick.price;
      c.volume = tick.quantity;
      this.traded.set(tick.pair, true);
    } else {
      c.high = Math.max(c.high, tick.price);
      c.low = Math.min(c.low, tick.price);
      c.close = tick.price;
      c.volume += tick.quantity;
    }
    return { closed, ignored: false };
  }

  /** Closes the minute (and any quiet minutes) once the clock has passed it. Call every second. */
  closeIfDue(pair: string, nowMs: number): Candle[] {
    const c = this.current.get(pair);
    const minute = bucketStart(nowMs, "1m");
    if (!c || minute <= c.openTimeMs) return [];
    return this.advance(pair, minute);
  }

  /** The minute still in progress for a pair (a copy, safe to store). */
  currentCandle(pair: string): Candle | null {
    const c = this.current.get(pair);
    return c ? { ...c } : null;
  }

  /** Forget the minute in progress (all pairs if none given). Trade IDs are kept. */
  reset(pair?: string): void {
    const pairs = pair ? [pair] : [...this.current.keys()];
    for (const p of pairs) {
      this.current.delete(p);
      this.traded.delete(p);
    }
  }

  private startMinute(pair: string, openTimeMs: number, price: number, volume: number, traded: boolean) {
    this.current.set(pair, { pair, timeframe: "1m", openTimeMs, open: price, high: price, low: price, close: price, volume });
    this.traded.set(pair, traded);
  }

  /** Closes the current minute, fills quiet minutes with flat candles, starts a placeholder at `toMinute`. */
  private advance(pair: string, toMinute: number): Candle[] {
    const c = this.current.get(pair)!;
    const out: Candle[] = [c];
    const quietMinutes = (toMinute - c.openTimeMs) / TIMEFRAMES["1m"] - 1;
    if (quietMinutes <= MAX_FLAT_FILL_MINUTES) {
      for (let t = c.openTimeMs + TIMEFRAMES["1m"]; t < toMinute; t += TIMEFRAMES["1m"]) {
        out.push({ pair, timeframe: "1m", openTimeMs: t, open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 });
      }
    }
    this.startMinute(pair, toMinute, c.close, 0, false);
    return out;
  }
}

/**
 * Combines 1m candles into a higher timeframe. Input may be in any order.
 * A bucket's open is its first minute's open and its close is its last minute's close.
 */
export function rollup(candles1m: readonly Candle[], timeframe: Timeframe): Candle[] {
  const sorted = [...candles1m].sort((a, b) => a.openTimeMs - b.openTimeMs);
  const buckets = new Map<string, Candle>();
  for (const c of sorted) {
    const openTimeMs = bucketStart(c.openTimeMs, timeframe);
    const key = `${c.pair}|${openTimeMs}`;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { ...c, timeframe, openTimeMs });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()];
}

export type Gap = { startMs: number; endMs: number; missing: number };

/**
 * Finds missing candles between fromMs (inclusive) and toMs (exclusive).
 * Returns contiguous ranges, e.g. one gap of 3 minutes instead of 3 separate gaps.
 */
export function findGaps(openTimes: readonly number[], timeframe: Timeframe, fromMs: number, toMs: number): Gap[] {
  const size = TIMEFRAMES[timeframe];
  const have = new Set(openTimes);
  const gaps: Gap[] = [];
  let gapStart: number | null = null;
  for (let t = bucketStart(fromMs, timeframe); t < toMs; t += size) {
    if (!have.has(t)) {
      if (gapStart === null) gapStart = t;
    } else if (gapStart !== null) {
      gaps.push({ startMs: gapStart, endMs: t, missing: (t - gapStart) / size });
      gapStart = null;
    }
  }
  if (gapStart !== null) {
    const end = Math.ceil(toMs / size) * size;
    gaps.push({ startMs: gapStart, endMs: end, missing: (end - gapStart) / size });
  }
  return gaps;
}
