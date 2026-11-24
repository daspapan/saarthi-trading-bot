// Message formats for each stream. Each parser takes one raw WebSocket text
// message and returns zero or more plain events. Anything unexpected is ignored
// (returns []), never thrown, so a strange message can't crash the feed.

import type { Tick } from "./candles.ts";
import type { Quote } from "./store.ts";

export type FeedEvent =
  | { kind: "trade"; tick: Tick }
  | { kind: "quote"; quote: Quote }
  | { kind: "price"; pair: string; price: number; timeMs: number };

/** "BTC/USDT" -> "BTCUSDT" */
export const toCompactSymbol = (pair: string) => pair.replace("/", "");
/** "BTC/USDT" -> "BTC-USD" (Coinbase quotes USD, not USDT) */
export const toCoinbaseProduct = (pair: string) => `${pair.split("/")[0]}-USD`;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function pairLookup(pairs: readonly string[], toVenue: (p: string) => string) {
  const map = new Map(pairs.map((p) => [toVenue(p), p]));
  return (venueSymbol: unknown) => (typeof venueSymbol === "string" ? map.get(venueSymbol) : undefined);
}

// ---------- Feed A: Binance Spot Testnet (trades + 24h ticker) ----------

export function binanceSubscribe(pairs: readonly string[]) {
  const streams = pairs.flatMap((p) => {
    const s = toCompactSymbol(p).toLowerCase();
    return [`${s}@trade`, `${s}@ticker`];
  });
  return { method: "SUBSCRIBE", params: streams, id: 1 };
}

export function binanceParser(pairs: readonly string[]) {
  const lookup = pairLookup(pairs, toCompactSymbol);
  return (text: string): FeedEvent[] => {
    const m = safeJson(text);
    const pair = m && lookup(m.s);
    if (!m || !pair) return [];
    if (m.e === "trade") {
      const price = num(m.p);
      const quantity = num(m.q);
      const timeMs = num(m.T);
      const tradeId = num(m.t);
      if (price === null || quantity === null || timeMs === null) return [];
      return [{ kind: "trade", tick: { pair, price, quantity, timeMs, tradeId: tradeId ?? undefined } }];
    }
    if (m.e === "24hrTicker") {
      const last = num(m.c);
      const timeMs = num(m.E);
      if (last === null || timeMs === null) return [];
      return [
        {
          kind: "quote",
          quote: { pair, bid: num(m.b), ask: num(m.a), last, change24hPct: num(m.P), volume24h: num(m.v), timeMs },
        },
      ];
    }
    return [];
  };
}

// ---------- Feed B option 1: Bybit public spot (mainnet, read-only) ----------

export function bybitSubscribe(pairs: readonly string[]) {
  return { op: "subscribe", args: pairs.map((p) => `tickers.${toCompactSymbol(p)}`) };
}
export const BYBIT_PING = { message: { op: "ping" }, everyMs: 20_000 };

export function bybitParser(pairs: readonly string[]) {
  const lookup = pairLookup(pairs, toCompactSymbol);
  return (text: string): FeedEvent[] => {
    const m = safeJson(text);
    if (!m || typeof m.topic !== "string" || !m.topic.startsWith("tickers.")) return [];
    const data = m.data as Record<string, unknown> | undefined;
    const pair = data && lookup(data.symbol);
    const price = data ? num(data.lastPrice) : null;
    const timeMs = num(m.ts);
    if (!pair || price === null || timeMs === null) return [];
    return [{ kind: "price", pair, price, timeMs }];
  };
}

// ---------- Feed B option 2: Coinbase Exchange public ticker ----------

export function coinbaseSubscribe(pairs: readonly string[]) {
  return { type: "subscribe", product_ids: pairs.map(toCoinbaseProduct), channels: ["ticker"] };
}

export function coinbaseParser(pairs: readonly string[]) {
  const lookup = pairLookup(pairs, toCoinbaseProduct);
  return (text: string): FeedEvent[] => {
    const m = safeJson(text);
    if (!m || m.type !== "ticker") return [];
    const pair = lookup(m.product_id);
    const price = num(m.price);
    const timeMs = typeof m.time === "string" ? Date.parse(m.time) : NaN;
    if (!pair || price === null || !Number.isFinite(timeMs)) return [];
    return [{ kind: "price", pair, price, timeMs }];
  };
}

/** Picks the right subscribe message, parser and ping for the cross-check URL. */
export function priceCheckVenue(url: string, pairs: readonly string[]) {
  const host = new URL(url).host;
  if (host === "stream.bybit.com") {
    return { name: "Bybit public", subscribe: bybitSubscribe(pairs), parse: bybitParser(pairs), ping: BYBIT_PING };
  }
  if (host === "ws-feed.exchange.coinbase.com") {
    return { name: "Coinbase public", subscribe: coinbaseSubscribe(pairs), parse: coinbaseParser(pairs), ping: undefined };
  }
  throw new Error(`No parser for price-check stream ${host}`);
}
