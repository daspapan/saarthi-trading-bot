// Indicators are checked two ways:
//  1. against independent textbook formulas written out below (not the library), and
//  2. against small cases you can work out by hand.
import { describe, expect, it } from "vitest";
import {
  type Candle,
  atrSeries,
  bollingerSeries,
  candlesPerDays,
  indicatorTable,
  indicatorsAt,
  latestIndicators,
  macdSeries,
  rsiSeries,
  volumeRatioSeries,
} from "../src/index.ts";

// Wilder's classic RSI dataset (New Concepts in Technical Trading Systems / StockCharts).
const WILDER = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22,
  45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];

// A fixed 120-candle series with trend, swings and changing ranges (deterministic, rounded to cents).
const FIXED: Candle[] = Array.from({ length: 120 }, (_, i) => {
  const mid = 100 + i * 0.15 + 6 * Math.sin(i / 7) + 2 * Math.sin(i / 2.3);
  const range = 1 + (i % 5) * 0.4;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    pair: "BTC/USDT",
    timeframe: "15m",
    openTimeMs: i * 900_000,
    open: r2(mid - 0.3),
    high: r2(mid + range),
    low: r2(mid - range),
    close: r2(mid + 0.2 * Math.cos(i)),
    volume: r2(50 + 20 * Math.sin(i / 3) + (i % 7)),
  };
});
const CLOSES = FIXED.map((c) => c.close);

// ---------- independent reference formulas ----------

function refRsi(closes: number[], n: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** EMA seeded with the simple average of the first n values. */
function refEma(values: number[], n: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  const k = 2 / (n + 1);
  let ema = values.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = ema;
  for (let i = n; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

function refMacd(closes: number[]) {
  const fast = refEma(closes, 12);
  const slow = refEma(closes, 26);
  const line: number[] = [];
  const lineIndex: number[] = [];
  closes.forEach((_, i) => {
    if (slow[i] !== null) {
      line.push(fast[i]! - slow[i]!);
      lineIndex.push(i);
    }
  });
  const signal = refEma(line, 9);
  const out: ({ macd: number; signal: number; histogram: number } | null)[] = closes.map(() => null);
  line.forEach((m, j) => {
    if (signal[j] !== null) out[lineIndex[j]!] = { macd: m, signal: signal[j]!, histogram: m - signal[j]! };
  });
  return out;
}

function refBollinger(closes: number[], n: number, k: number) {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    const w = closes.slice(i - n + 1, i + 1);
    const mean = w.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / n); // population standard deviation
    return { upper: mean + k * sd, middle: mean, lower: mean - k * sd };
  });
}

/** True range needs a previous close, so TR starts at candle 1 and the first ATR is at candle n. */
function refAtr(c: Candle[], n: number) {
  const tr = c.map((x, i) =>
    i === 0 ? Number.NaN : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1]!.close), Math.abs(x.low - c[i - 1]!.close)),
  );
  const out: (number | null)[] = c.map(() => null);
  let atr = tr.slice(1, n + 1).reduce((a, b) => a + b, 0) / n;
  out[n] = atr;
  for (let i = n + 1; i < c.length; i++) {
    atr = (atr * (n - 1) + tr[i]!) / n;
    out[i] = atr;
  }
  return out;
}

/** Compares two aligned series: same null positions, values within `tol`. */
function expectSeriesClose(actual: (number | null)[], expected: (number | null)[], tol: number) {
  expect(actual.length).toBe(expected.length);
  const firstA = actual.findIndex((v) => v !== null);
  const firstE = expected.findIndex((v) => v !== null);
  expect(firstA).toBe(firstE);
  for (let i = firstE; i < expected.length; i++) expect(actual[i]).toBeCloseTo(expected[i]!, tol);
}

describe("IND-01 RSI 14", () => {
  it("IND-01 matches Wilder's formula on his own dataset (first values 70.46, 66.25, 66.48, 69.35, 66.29, 57.92)", () => {
    const rsi = rsiSeries(WILDER, 14);
    expect(rsi.slice(14, 20).map((v) => Math.round(v! * 100) / 100)).toEqual([70.46, 66.25, 66.48, 69.35, 66.29, 57.92]);
    expectSeriesClose(rsi, refRsi(WILDER, 14), 1);
  });

  it("IND-01 matches the reference formula on the fixed 120-candle series", () => {
    expectSeriesClose(rsiSeries(CLOSES, 14), refRsi(CLOSES, 14), 1);
  });

  it("IND-01 is 100 for a series that only goes up, and stays between 0 and 100", () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsiSeries(up).at(-1)).toBe(100);
    for (const v of rsiSeries(CLOSES)) if (v !== null) expect(v).toBeGreaterThanOrEqual(0), expect(v).toBeLessThanOrEqual(100);
  });
});

describe("IND-02 MACD 12/26/9", () => {
  it("IND-02 matches the reference EMA formula (line, signal and histogram)", () => {
    const lib = macdSeries(CLOSES);
    const ref = refMacd(CLOSES);
    expectSeriesClose(lib.map((v) => v?.macd ?? null), ref.map((v) => v?.macd ?? null), 6);
    expectSeriesClose(lib.map((v) => v?.signal ?? null), ref.map((v) => v?.signal ?? null), 6);
    expectSeriesClose(lib.map((v) => v?.histogram ?? null), ref.map((v) => v?.histogram ?? null), 6);
  });

  it("IND-02 first value appears at candle 34 (26 for the slow EMA + 9 for the signal - 1)", () => {
    const m = macdSeries(CLOSES);
    expect(m[32]).toBeNull();
    expect(m[33]).not.toBeNull();
  });

  it("IND-02 is zero on a flat series (the library reports a 0 signal as undefined; we rebuild it)", () => {
    const flat = new Array(60).fill(250);
    expect(macdSeries(flat).at(-1)).toEqual({ macd: 0, signal: 0, histogram: 0 });
  });
});

describe("IND-03 Bollinger 20/2", () => {
  it("IND-03 matches the reference formula (20-period mean ± 2 population standard deviations)", () => {
    const lib = bollingerSeries(CLOSES);
    const ref = refBollinger(CLOSES, 20, 2);
    for (const k of ["upper", "middle", "lower"] as const) {
      expectSeriesClose(lib.map((v) => v?.[k] ?? null), ref.map((v) => v?.[k] ?? null), 6);
    }
  });

  it("IND-03 band width is (upper - lower) / middle as a percent, and zero for a flat series", () => {
    const b = bollingerSeries(CLOSES).at(-1)!;
    expect(b.widthPct).toBeCloseTo(((b.upper - b.lower) / b.middle) * 100, 10);
    expect(bollingerSeries(new Array(20).fill(10)).at(-1)).toEqual({ upper: 10, middle: 10, lower: 10, widthPct: 0 });
  });
});

describe("IND-04 ATR 14", () => {
  it("IND-04 matches Wilder's true-range formula", () => {
    expectSeriesClose(atrSeries(FIXED, 14), refAtr(FIXED, 14), 6);
  });

  it("IND-04 equals the candle range when every candle has the same range and no gaps", () => {
    const same: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      pair: "X",
      timeframe: "1m",
      openTimeMs: i,
      open: 100,
      high: 103,
      low: 99,
      close: 100,
      volume: 1,
    }));
    expect(atrSeries(same).at(-1)).toBeCloseTo(4, 10);
  });
});

describe("IND-05 volume vs 30-day average", () => {
  it("IND-05 is each candle's volume over the average of the previous lookback candles", () => {
    const vols = [10, 20, 30, 40, 50];
    const candles = vols.map((v, i) => ({ ...FIXED[i]!, volume: v }));
    // lookback 3: candle 3 -> 40 / avg(10,20,30) = 2; candle 4 -> 50 / avg(20,30,40) = 1.666...
    expect(volumeRatioSeries(candles, 3)).toEqual([null, null, null, 2, 50 / 30]);
  });

  it("IND-05 30 days means 2880 candles on 15m and 180 on 4h", () => {
    expect(candlesPerDays("15m", 30)).toBe(2880);
    expect(candlesPerDays("4h", 30)).toBe(180);
    expect(candlesPerDays("1h", 30)).toBe(720);
  });

  it("IND-05 a zero average gives 'not available', not infinity", () => {
    const candles = [0, 0, 0, 5].map((v, i) => ({ ...FIXED[i]!, volume: v }));
    expect(volumeRatioSeries(candles, 3)).toEqual([null, null, null, null]);
  });
});

describe("IND-06 too little data", () => {
  it("IND-06 every indicator returns null (not NaN, not 0) until it has enough candles", () => {
    const few = FIXED.slice(0, 10);
    const closes = few.map((c) => c.close);
    expect(rsiSeries(closes)).toEqual(new Array(10).fill(null));
    expect(macdSeries(closes)).toEqual(new Array(10).fill(null));
    expect(bollingerSeries(closes)).toEqual(new Array(10).fill(null));
    expect(atrSeries(few)).toEqual(new Array(10).fill(null));
    expect(volumeRatioSeries(few, 2880)).toEqual(new Array(10).fill(null));
  });

  it("IND-06 the snapshot view says 'not available' with nulls, and nothing is NaN or a fake 0", () => {
    const set = latestIndicators(FIXED.slice(0, 25), "15m")!;
    expect(set.rsi).not.toBeNull(); // 25 candles: RSI and Bollinger are ready...
    expect(set.bollinger).not.toBeNull();
    expect(set.macd).toBeNull(); // ...MACD and the 30-day volume average are not
    expect(set.volumeRatio).toBeNull();
    for (const v of Object.values(set)) if (typeof v === "number") expect(Number.isNaN(v)).toBe(false);
  });

  it("IND-06 empty input is safe", () => {
    expect(latestIndicators([], "15m")).toBeNull();
    expect(rsiSeries([])).toEqual([]);
    expect(indicatorsAt(indicatorTable([], "4h"), 0)).toBeNull();
  });

  it("IND-06 all series stay aligned with the candles they came from", () => {
    const t = indicatorTable(FIXED, "15m");
    for (const s of [t.rsi, t.macd, t.bollinger, t.atr, t.volumeRatio]) expect(s).toHaveLength(FIXED.length);
    const at = indicatorsAt(t, 50)!;
    expect(at.time).toBe(FIXED[50]!.openTimeMs);
    expect(at.prevMacd).toEqual(t.macd[49]);
  });
});
