import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  appendAudit,
  auditHash,
  binanceParser,
  binanceSubscribe,
  bybitParser,
  bybitSubscribe,
  canonicalJson,
  coinbaseParser,
  coinbaseSubscribe,
  priceCheckVenue,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const PAIRS = ["BTC/USDT", "ETH/USDT", "SOL/USDT"];

describe("FEED-01 / FEED-02 Binance testnet messages (feed A)", () => {
  const parse = binanceParser(PAIRS);

  it("FEED-01 subscribes to trades and the 24h ticker for every pair", () => {
    expect(binanceSubscribe(["BTC/USDT", "SOL/USDT"])).toEqual({
      method: "SUBSCRIBE",
      params: ["btcusdt@trade", "btcusdt@ticker", "solusdt@trade", "solusdt@ticker"],
      id: 1,
    });
  });

  it("FEED-01 turns a trade message into a tick with its trade ID", () => {
    const msg = { e: "trade", E: 1, s: "BTCUSDT", t: 12345, p: "97123.45", q: "0.002", T: 1767225601000 };
    expect(parse(JSON.stringify(msg))).toEqual([
      { kind: "trade", tick: { pair: "BTC/USDT", price: 97123.45, quantity: 0.002, timeMs: 1767225601000, tradeId: 12345 } },
    ]);
  });

  it("FEED-02 turns a 24h ticker into bid, ask, last, change and volume", () => {
    const msg = { e: "24hrTicker", E: 1767225601000, s: "ETHUSDT", P: "2.15", c: "3456.7", b: "3456.6", a: "3456.8", v: "9876.5" };
    expect(parse(JSON.stringify(msg))).toEqual([
      {
        kind: "quote",
        quote: { pair: "ETH/USDT", bid: 3456.6, ask: 3456.8, last: 3456.7, change24hPct: 2.15, volume24h: 9876.5, timeMs: 1767225601000 },
      },
    ]);
  });

  it.each([
    ["not json", "{oops"],
    ["subscribe acknowledgement", JSON.stringify({ result: null, id: 1 })],
    ["unknown pair", JSON.stringify({ e: "trade", s: "DOGEUSDT", t: 1, p: "1", q: "1", T: 1 })],
    ["price is not a number", JSON.stringify({ e: "trade", s: "BTCUSDT", t: 1, p: "abc", q: "1", T: 1 })],
    ["ticker without a time", JSON.stringify({ e: "24hrTicker", s: "BTCUSDT", c: "1" })],
    ["other event type", JSON.stringify({ e: "kline", s: "BTCUSDT" })],
    ["a JSON array", "[1,2,3]"],
  ])("FEED-01 ignores %s without throwing", (_label, text) => {
    expect(parse(text)).toEqual([]);
  });
});

describe("FEED-04 cross-check streams (feed B)", () => {
  it("FEED-04 Bybit public tickers give the last price per pair", () => {
    const parse = bybitParser(PAIRS);
    const msg = { topic: "tickers.SOLUSDT", ts: 1767225601000, type: "snapshot", data: { symbol: "SOLUSDT", lastPrice: "201.55" } };
    expect(parse(JSON.stringify(msg))).toEqual([{ kind: "price", pair: "SOL/USDT", price: 201.55, timeMs: 1767225601000 }]);
    expect(parse(JSON.stringify({ op: "pong", success: true }))).toEqual([]);
    expect(parse(JSON.stringify({ topic: "tickers.XRPUSDT", ts: 1, data: { symbol: "XRPUSDT", lastPrice: "1" } }))).toEqual([]);
    expect(bybitSubscribe(["BTC/USDT"])).toEqual({ op: "subscribe", args: ["tickers.BTCUSDT"] });
  });

  it("FEED-04 Coinbase tickers map BTC-USD to BTC/USDT", () => {
    const parse = coinbaseParser(PAIRS);
    const msg = { type: "ticker", product_id: "BTC-USD", price: "97000.10", time: "2026-01-01T00:00:01.000Z" };
    expect(parse(JSON.stringify(msg))).toEqual([{ kind: "price", pair: "BTC/USDT", price: 97000.1, timeMs: Date.UTC(2026, 0, 1, 0, 0, 1) }]);
    expect(parse(JSON.stringify({ type: "heartbeat" }))).toEqual([]);
    expect(parse(JSON.stringify({ ...msg, time: "not a date" }))).toEqual([]);
    expect(coinbaseSubscribe(["ETH/USDT"])).toEqual({ type: "subscribe", product_ids: ["ETH-USD"], channels: ["ticker"] });
  });

  it("FEED-04 picks the parser from the configured URL, with a ping only for Bybit", () => {
    expect(priceCheckVenue("wss://stream.bybit.com/v5/public/spot", PAIRS)).toMatchObject({ name: "Bybit public", ping: { everyMs: 20_000 } });
    expect(priceCheckVenue("wss://ws-feed.exchange.coinbase.com", PAIRS)).toMatchObject({ name: "Coinbase public", ping: undefined });
    expect(() => priceCheckVenue("wss://example.com", PAIRS)).toThrow(/No parser/);
  });
});

describe("FEED-03 health alarms go into the hash-chained audit log", () => {
  it("FEED-03 each row chains to the previous row's hash, starting from the genesis hash", () => {
    const { db } = tempDb();
    const a = appendAudit(db, "health_alarm", "feed", { kind: "feeds_paused", b: 2, a: 1 });
    const b = appendAudit(db, "health_resumed", "feed", { kind: "feeds_resumed" });
    expect(a.prev_hash).toBe(GENESIS_HASH);
    expect(b.prev_hash).toBe(a.hash);
    expect(a.hash).toBe(auditHash(GENESIS_HASH, "health_alarm", "feed", a.payload_json, a.created_at));
    expect(a.payload_json).toBe('{"a":1,"b":2,"kind":"feeds_paused"}'); // canonical: keys sorted
  });

  it("FEED-03 canonical JSON sorts keys at every level and keeps arrays in order", () => {
    expect(canonicalJson({ b: { d: 1, c: [3, { f: 1, e: 2 }] }, a: null })).toBe('{"a":null,"b":{"c":[3,{"e":2,"f":1}],"d":1}}');
  });
});

describe("AUD-01 audit rows inside a larger transaction", () => {
  it("AUD-01 appendAudit joins an open transaction, and a rollback removes its row too", () => {
    const { db } = tempDb();
    db.exec("BEGIN IMMEDIATE");
    appendAudit(db, "signal", "analyst", { n: 1 });
    db.exec("ROLLBACK");
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    db.exec("BEGIN IMMEDIATE");
    appendAudit(db, "signal", "analyst", { n: 2 });
    db.exec("COMMIT");
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 1 });
  });
});
