// The Binance testnet client: testnet-only guard, error mapping, wire format,
// and the full executor running on it (PAPER-02: same code path as paper).

import { describe, expect, it } from "vitest";
import ccxt from "ccxt";
import { join } from "node:path";
import {
  ConfigError,
  Executor,
  ExchangeError,
  PaperExchange,
  type Candidate,
  enqueue,
  getOrderRow,
  loadSettingsFile,
  seedPaper,
  writeEvaluation,
  writePriceState,
} from "@saarthi/core";
import { tempDb } from "../../../packages/core/test/helpers.ts";
import { BinanceTestnetClient, makeCcxtTestnet, mapOrder, toExchangeError } from "../src/binance.ts";
import { createExchangeClient } from "../src/client.ts";
import { fakeBinance } from "./fakeBinance.ts";

const RISK = loadSettingsFile(join(import.meta.dirname, "..", "..", "..", "config"), "risk.json");

describe("Rule 6: the Binance client only ever talks to the testnet", () => {
  it("TN-01 the real ccxt client in sandbox mode points at testnet.binance.vision", () => {
    const raw = makeCcxtTestnet({ apiKey: "k", secret: "s" });
    expect(raw.urls.api.public).toMatch(/^https:\/\/testnet\.binance\.vision\//);
    expect(raw.urls.api.private).toMatch(/^https:\/\/testnet\.binance\.vision\//);
    expect(() => new BinanceTestnetClient(raw)).not.toThrow();
  });

  it.each(["https://api.binance.com/api/v3", "https://testnet.binance.vision.evil.com/api/v3", "http://testnet.binance.vision/api/v3"])(
    "TN-01 refuses to build a client whose private URL is %s",
    (url) => {
      const { db } = tempDb();
      const raw = fakeBinance(db, new PaperExchange(db, { price: () => 1 }));
      raw.urls.api.private = url;
      expect(() => new BinanceTestnetClient(raw)).toThrow(ConfigError);
    },
  );

  it("TN-01 a mainnet ccxt client (sandbox mode off) is refused", () => {
    const ex = new ccxt.binance({ apiKey: "k", secret: "s" });
    expect(() => new BinanceTestnetClient(ex as never)).toThrow(/not a known testnet/);
  });
});

describe("Errors are mapped so the executor knows whether to retry", () => {
  it.each([
    [new ccxt.RateLimitExceeded("binance 429 Too Many Requests"), "rate_limit", true],
    [new ccxt.DDoSProtection("binance 418"), "rate_limit", true],
    [new ccxt.RequestTimeout("timed out"), "network", true],
    [new ccxt.ExchangeNotAvailable("502"), "network", true],
    [new ccxt.InsufficientFunds("Account has insufficient balance"), "insufficient_balance", false],
    [new ccxt.OrderNotFound("Order does not exist."), "not_found", false],
    [new ccxt.InvalidOrder("Filter failure: LOT_SIZE"), "rejected", false],
    [new ccxt.AuthenticationError("Invalid API-key"), "rejected", false],
    [new Error("socket hang up"), "network", true],
    [new Error('binance {"code":-2013,"msg":"Order does not exist."}'), "not_found", false],
    [new Error('binance {"code":-1013,"msg":"Filter failure: NOTIONAL"}'), "rejected", false],
  ])("EX-18 %s -> %s (retryable: %s)", (err, kind, retryable) => {
    const e = toExchangeError(err);
    expect(e).toBeInstanceOf(ExchangeError);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
  });
});

describe("Wire format", () => {
  it("EX-16 quantities and prices go out as plain decimals at the market's precision (never 1e-5)", async () => {
    const { db } = tempDb();
    seedPaper(db);
    const raw = fakeBinance(db, new PaperExchange(db, { price: () => 100_000 }));
    const client = new BinanceTestnetClient(raw);
    await client.createOrder({ pair: "BTC/USDT", side: "buy", type: "limit", quantity: 0.00007, price: 80_000, clientOrderId: "sa1" });
    const sent = raw.calls.find((c) => c.method === "newOrder")!.params;
    expect(sent).toMatchObject({ symbol: "BTCUSDT", side: "BUY", type: "LIMIT", quantity: "0.00007", price: "80000.00", timeInForce: "GTC", newClientOrderId: "sa1" });
  });

  it("EX-14 fees are converted to USDT whatever asset Binance charged them in", () => {
    const base = { orderId: 1, clientOrderId: "x", price: "0", origQty: "0.01", executedQty: "0.01", cummulativeQuoteQty: "1000", status: "FILLED", type: "MARKET", side: "BUY" };
    expect(mapOrder({ ...base, fills: [{ price: "100000", qty: "0.01", commission: "1", commissionAsset: "USDT" }] }, "BTC/USDT").fee).toBe(1);
    expect(mapOrder({ ...base, fills: [{ price: "100000", qty: "0.01", commission: "0.00001", commissionAsset: "BTC" }] }, "BTC/USDT").fee).toBeCloseTo(1, 9);
    expect(mapOrder({ ...base, fills: [{ price: "100000", qty: "0.01", commission: "0.002", commissionAsset: "BNB" }] }, "BTC/USDT").fee).toBeCloseTo(1, 9);
    expect(mapOrder(base, "BTC/USDT")).toMatchObject({ fee: 1, avgPrice: 100_000, status: "filled", price: null, type: "market" });
    expect(mapOrder({ ...base, status: "PARTIALLY_FILLED" }, "BTC/USDT").status).toBe("open");
    expect(mapOrder({ ...base, status: "EXPIRED_IN_MATCH" }, "BTC/USDT").status).toBe("expired");
  });
});

describe("PAPER-02 switching mode changes only the exchange client", () => {
  it("PAPER-02 paper -> PaperExchange, testnet -> BinanceTestnetClient, backtest -> none", () => {
    const { db } = tempDb();
    const keys = { binance: { apiKey: "k", secret: "s" }, bybit: null };
    expect(createExchangeClient("paper", { db, keys })).toBeInstanceOf(PaperExchange);
    expect(createExchangeClient("testnet", { db, keys })).toBeInstanceOf(BinanceTestnetClient);
    expect(createExchangeClient("backtest", { db, keys })).toBeNull();
    expect(() => createExchangeClient("testnet", { db, keys: { binance: null, bybit: null } })).toThrow(/needs BINANCE_API_KEY/);
  });

  it("PAPER-02 the executor's own code never looks at the trading mode or the client type", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = join(import.meta.dirname, "..", "..", "..", "packages", "core", "src", "executor");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/tradingMode|TRADING_MODE|PaperExchange|BinanceTestnet|instanceof\s+\w*Exchange\b/);
    }
  });

  it("PAPER-02 the same executor runs a trade to OPEN on the Binance client, exactly as on paper", async () => {
    const run = async (useBinance: boolean) => {
      const { db } = tempDb();
      seedPaper(db);
      let now = Date.UTC(2026, 0, 5, 12);
      let price = 100_050;
      const paper = new PaperExchange(db, { price: () => price, now: () => now });
      const client = useBinance ? new BinanceTestnetClient(fakeBinance(db, paper)) : paper;
      const executor = new Executor({ db, client, risk: () => RISK, now: () => now });
      const c: Candidate = { id: "m-1", strategy: "momentum", pair: "BTC/USDT", direction: "long", entry: 100_000, stop: 99_400, target: 101_200, rewardToRisk: 2, stopAtr: 1.5, atr: 400, quantity: 0.025, notional: 2500, riskAmount: 15, score: 0.5, reason: "r", dataPoints: [] };
      db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES ('BTC/USDT', 'long', '{}', 't', 'x')").run();
      enqueue(db, { signalId: 1, snapshotHash: "a".repeat(64), pair: "BTC/USDT", direction: "long", candidateId: "m-1", confidence: "medium", candidate: c }, { nowMs: now });
      const feed = { status: "ok", lastDataMs: 0, stalePairs: [], detail: "" };
      const trusted = { feeds: { A: feed, B: feed }, pairs: [], problems: [], paused: false, reason: null, agreeSinceMs: null, resumeInMs: null, change: null };
      for (let i = 0; i < 8; i++) {
        now += 1000;
        if (i === 4) price = 99_990;
        writePriceState(db, { pair: "BTC/USDT", bid: null, ask: null, last: price, change24hPct: null, volume24h: null, timeMs: now }, null, null, now);
        writeEvaluation(db, trusted as never, 60, now);
        paper.process();
        await executor.tick();
      }
      const o = getOrderRow(db, 1);
      const events = (db.prepare("SELECT to_state FROM order_events WHERE order_id = 1 ORDER BY id").all() as { to_state: string }[]).map((e) => e.to_state);
      return { state: o.state, filled: o.filled_quantity, avg: o.avg_fill_price, events };
    };
    const paperRun = await run(false);
    const binanceRun = await run(true);
    expect(paperRun.state).toBe("OPEN");
    expect(binanceRun).toEqual(paperRun);
  });
});
