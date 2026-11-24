// Deterministic synthetic markets for backtest tests (no randomness, no network).
import type { Candle } from "../src/index.ts";

export const BAR = 900_000;
export const START = Date.UTC(2025, 0, 1);

export function makeCandles(pair: string, closes: number[], volumes: number[], start = START, step = BAR, tf: Candle["timeframe"] = "15m"): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1]!;
    return {
      pair,
      timeframe: tf,
      openTimeMs: start + i * step,
      open,
      high: Math.max(open, close) * 1.0015,
      low: Math.min(open, close) * 0.9985,
      close,
      volume: volumes[i]!,
    };
  });
}

/**
 * BTC with waves and volume bursts, ETH = BTC / 33 times a slow wobble (so the
 * ratio stretches and reverts), SOL quiet and choppy. Enough for all three
 * strategies to fire over ~60 days of 15m candles.
 */
export function syntheticMarket(bars = 6_000) {
  const btc: number[] = [];
  const eth: number[] = [];
  const sol: number[] = [];
  const vol: number[] = [];
  for (let i = 0; i < bars; i++) {
    const b = 100_000 * (1 + 0.00002 * i + 0.03 * Math.sin(i / 90) + 0.006 * Math.sin(i / 7));
    btc.push(Math.round(b * 100) / 100);
    eth.push(Math.round((b / 33) * (1 + 0.012 * Math.sin(i / 160) + 0.002 * Math.sin(i / 5)) * 100) / 100);
    sol.push(Math.round(200 * (1 + 0.004 * Math.sin(i / 11) + 0.0015 * Math.sin(i / 3)) * 1000) / 1000);
    vol.push(100 + 60 * Math.max(0, Math.sin(i / 13)) + (i % 17 === 0 ? 120 : 0));
  }
  return {
    "BTC/USDT": makeCandles("BTC/USDT", btc, vol),
    "ETH/USDT": makeCandles("ETH/USDT", eth, vol),
    "SOL/USDT": makeCandles("SOL/USDT", sol, vol),
  };
}
