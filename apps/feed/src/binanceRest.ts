// Binance Spot Testnet public REST calls: no keys, read-only.
//   GET /api/v3/ping    health check
//   GET /api/v3/klines  candle history, for backfilling gaps

import { type Candle, TIMEFRAMES, type Timeframe, toCompactSymbol } from "@saarthi/core";

const TIMEOUT_MS = 5_000;
const MAX_PER_REQUEST = 1000; // Binance's limit for klines

type FetchFn = typeof fetch;

export function makeBinanceRest(baseUrl: string, fetchFn: FetchFn = fetch) {
  async function getJson(path: string): Promise<unknown> {
    const res = await fetchFn(`${baseUrl}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Binance answered HTTP ${res.status} for ${path.split("?")[0]}`);
    return res.json();
  }

  async function ping(): Promise<void> {
    await getJson("/api/v3/ping");
  }

  /** Candles in [startMs, endMs), following pages of up to 1000. */
  async function fetchKlines(pair: string, timeframe: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let from = startMs;
    while (from < endMs) {
      const qs = new URLSearchParams({
        symbol: toCompactSymbol(pair),
        interval: timeframe,
        startTime: String(from),
        endTime: String(endMs - 1),
        limit: String(MAX_PER_REQUEST),
      });
      const rows = (await getJson(`/api/v3/klines?${qs}`)) as unknown[][];
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        out.push({
          pair,
          timeframe,
          openTimeMs: Number(r[0]),
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
        });
      }
      const lastOpen = Number(rows.at(-1)![0]);
      from = lastOpen + TIMEFRAMES[timeframe];
      if (rows.length < MAX_PER_REQUEST) break;
    }
    return out;
  }

  return { ping, fetchKlines };
}
