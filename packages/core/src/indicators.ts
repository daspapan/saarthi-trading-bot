// Technical indicators, computed by code (rule 2: AI explains, code computes).
//
// Every function returns a SERIES aligned with its input: element i is the
// indicator value at candle i, or null while there isn't enough data yet
// ("not available"). Never NaN, never a fake 0. The same series power the
// live snapshot (take the last element) and the backtester (walk forward),
// so live and backtest use exactly the same maths.
//
// RSI, MACD, Bollinger Bands and ATR come from the `technicalindicators`
// library. Tests check them against independent textbook formulas.

import { ATR, BollingerBands, MACD, RSI } from "technicalindicators";
import { TIMEFRAMES, type Candle, type Timeframe } from "./feed/candles.ts";

export type Series<T> = (T | null)[];

export type MacdValue = { macd: number; signal: number; histogram: number };
export type BollingerValue = { upper: number; middle: number; lower: number; widthPct: number };

/** Puts a shorter library result back in line with the input (nulls in front). */
function alignRight<T>(length: number, values: readonly T[]): Series<T> {
  const out: Series<T> = new Array(Math.max(0, length - values.length)).fill(null);
  for (const v of values) out.push(v);
  return out.slice(0, length);
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/** RSI (Wilder), default 14. First value at index `period`. */
export function rsiSeries(closes: readonly number[], period = 14): Series<number> {
  if (closes.length <= period) return new Array(closes.length).fill(null);
  return alignRight(closes.length, RSI.calculate({ values: [...closes], period })).map((v) => (finite(v) ? v : null));
}

/** MACD with EMAs, default 12/26/9. Values exist once the signal line exists. */
export function macdSeries(closes: readonly number[], fast = 12, slow = 26, signal = 9): Series<MacdValue> {
  const raw = MACD.calculate({
    values: [...closes],
    fastPeriod: fast,
    slowPeriod: slow,
    signalPeriod: signal,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return alignRight(closes.length, raw).map((v) => {
    if (!v || !finite(v.MACD) || !finite(v.histogram)) return null;
    // technicalindicators drops a signal of exactly 0 (reports undefined) while the
    // histogram is still right, so rebuild it: signal = MACD - histogram.
    const sig = finite(v.signal) ? v.signal : v.MACD - v.histogram;
    return { macd: v.MACD, signal: sig, histogram: v.histogram };
  });
}

/** Bollinger Bands, default 20 periods and 2 standard deviations. */
export function bollingerSeries(closes: readonly number[], period = 20, stdDev = 2): Series<BollingerValue> {
  if (closes.length < period) return new Array(closes.length).fill(null);
  const raw = BollingerBands.calculate({ values: [...closes], period, stdDev });
  return alignRight(closes.length, raw).map((v) =>
    v && finite(v.upper) && finite(v.middle) && finite(v.lower) && v.middle !== 0
      ? { upper: v.upper, middle: v.middle, lower: v.lower, widthPct: ((v.upper - v.lower) / v.middle) * 100 }
      : null,
  );
}

/**
 * Average True Range (Wilder), default 14. True range needs the previous close,
 * so the first ATR (at index `period`) averages the true ranges of candles 1..period,
 * then each next value is smoothed: ATR = (prevATR × 13 + TR) / 14.
 */
export function atrSeries(candles: readonly Candle[], period = 14): Series<number> {
  if (candles.length <= period) return new Array(candles.length).fill(null);
  const raw = ATR.calculate({
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    period,
  });
  return alignRight(candles.length, raw).map((v) => (finite(v) ? v : null));
}

/** How many candles of this timeframe make `days` days. */
export function candlesPerDays(timeframe: Timeframe, days: number): number {
  return Math.round((days * 24 * 60 * 60_000) / TIMEFRAMES[timeframe]);
}

/**
 * Volume of each candle divided by the average volume of the `lookback`
 * candles BEFORE it (30 days by default). 1.4 means "40% above normal".
 * Not available until a full lookback exists, or if the average is zero.
 */
export function volumeRatioSeries(candles: readonly Candle[], lookback: number): Series<number> {
  const out: Series<number> = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= lookback) {
      const avg = sum / lookback;
      out[i] = avg > 0 ? candles[i]!.volume / avg : null;
      sum -= candles[i - lookback]!.volume;
    }
    sum += candles[i]!.volume;
  }
  return out;
}

/** All indicators for one timeframe at one moment. Null = not available. */
export type IndicatorSet = {
  time: number;
  close: number;
  rsi: number | null;
  macd: MacdValue | null;
  prevMacd: MacdValue | null;
  bollinger: BollingerValue | null;
  atr: number | null;
  volumeRatio: number | null;
};

export type IndicatorTable = {
  timeframe: Timeframe;
  candles: readonly Candle[];
  rsi: Series<number>;
  macd: Series<MacdValue>;
  bollinger: Series<BollingerValue>;
  atr: Series<number>;
  volumeRatio: Series<number>;
};

/** Computes every series for a candle list once. Used by the backtester and the snapshot. */
export function indicatorTable(candles: readonly Candle[], timeframe: Timeframe, volumeLookbackDays = 30): IndicatorTable {
  const closes = candles.map((c) => c.close);
  return {
    timeframe,
    candles,
    rsi: rsiSeries(closes),
    macd: macdSeries(closes),
    bollinger: bollingerSeries(closes),
    atr: atrSeries(candles),
    volumeRatio: volumeRatioSeries(candles, candlesPerDays(timeframe, volumeLookbackDays)),
  };
}

/** The indicator values at candle index i. */
export function indicatorsAt(table: IndicatorTable, i: number): IndicatorSet | null {
  const c = table.candles[i];
  if (!c) return null;
  return {
    time: c.openTimeMs,
    close: c.close,
    rsi: table.rsi[i] ?? null,
    macd: table.macd[i] ?? null,
    prevMacd: i > 0 ? (table.macd[i - 1] ?? null) : null,
    bollinger: table.bollinger[i] ?? null,
    atr: table.atr[i] ?? null,
    volumeRatio: table.volumeRatio[i] ?? null,
  };
}

/** Indicators at the most recent candle. */
export function latestIndicators(candles: readonly Candle[], timeframe: Timeframe): IndicatorSet | null {
  return indicatorsAt(indicatorTable(candles, timeframe), candles.length - 1);
}
