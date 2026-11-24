import { describe, expect, it } from "vitest";
import { makeBinanceRest } from "../src/binanceRest.ts";

const T0 = Date.UTC(2026, 0, 1);
const MIN = 60_000;
const kline = (minute: number, close: number) => [T0 + minute * MIN, "1", "2", "0.5", String(close), "10", T0 + minute * MIN + 59_999];

function fakeFetch(handler: (url: URL) => { status?: number; body: unknown }) {
  const urls: URL[] = [];
  const fn = (async (input: string | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const { status = 200, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, urls };
}

describe("FEED-08 Binance testnet REST", () => {
  it("FEED-08 klines are requested with the right symbol, interval and window, and parsed", async () => {
    const { fn, urls } = fakeFetch(() => ({ body: [kline(0, 100), kline(1, 101)] }));
    const rest = makeBinanceRest("https://testnet.binance.vision", fn);
    const candles = await rest.fetchKlines("ETH/USDT", "1m", T0, T0 + 2 * MIN);
    expect(urls[0]!.pathname).toBe("/api/v3/klines");
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
      symbol: "ETHUSDT",
      interval: "1m",
      startTime: String(T0),
      endTime: String(T0 + 2 * MIN - 1),
      limit: "1000",
    });
    expect(candles[1]).toEqual({ pair: "ETH/USDT", timeframe: "1m", openTimeMs: T0 + MIN, open: 1, high: 2, low: 0.5, close: 101, volume: 10 });
  });

  it("FEED-08 follows pages of 1000 until the window is covered", async () => {
    const { fn, urls } = fakeFetch((url) => {
      const start = Number(url.searchParams.get("startTime"));
      const first = (start - T0) / MIN;
      const count = first === 0 ? 1000 : 500;
      return { body: Array.from({ length: count }, (_, i) => kline(first + i, 1)) };
    });
    const rest = makeBinanceRest("https://testnet.binance.vision", fn);
    const candles = await rest.fetchKlines("BTC/USDT", "1m", T0, T0 + 1500 * MIN);
    expect(urls).toHaveLength(2);
    expect(urls[1]!.searchParams.get("startTime")).toBe(String(T0 + 1000 * MIN));
    expect(candles).toHaveLength(1500);
  });

  it("FEED-08 an empty answer stops paging", async () => {
    const { fn, urls } = fakeFetch(() => ({ body: [] }));
    const rest = makeBinanceRest("https://testnet.binance.vision", fn);
    expect(await rest.fetchKlines("BTC/USDT", "4h", T0, T0 + 10 * 4 * 60 * MIN)).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it("FEED-07 ping succeeds on HTTP 200 and fails with a plain message otherwise", async () => {
    const ok = makeBinanceRest("https://testnet.binance.vision", fakeFetch(() => ({ body: {} })).fn);
    await expect(ok.ping()).resolves.toBeUndefined();
    const down = makeBinanceRest("https://testnet.binance.vision", fakeFetch(() => ({ status: 503, body: {} })).fn);
    await expect(down.ping()).rejects.toThrow("Binance answered HTTP 503 for /api/v3/ping");
  });
});
