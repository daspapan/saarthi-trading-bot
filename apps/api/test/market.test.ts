import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import {
  type Evaluation,
  FEED_SOURCE,
  loadBaseEnv,
  upsertCandle,
  writeEvaluation,
  writePriceState,
} from "@saarthi/core";
import { tempDb, validEnv } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/app.ts";

async function start() {
  const { db } = tempDb();
  const app = createApp(db, loadBaseEnv(validEnv()));
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => {
    const res = await fetch(url + path);
    return { status: res.status, body: await res.json() };
  };
  return { db, get, close: () => server.close() };
}

const evaluation = (paused: boolean, reason: string | null, agreeSinceMs: number | null = null): Evaluation => ({
  feeds: {
    A: { status: "ok", lastDataMs: Date.now() - 2_000, stalePairs: [], detail: "Feed A is live" },
    B: paused
      ? { status: "stale", lastDataMs: Date.now() - 20_000, stalePairs: ["BTC/USDT"], detail: "Feed B has no data for 15 s on BTC/USDT" }
      : { status: "ok", lastDataMs: Date.now() - 1_000, stalePairs: [], detail: "Feed B is live" },
  },
  pairs: [{ pair: "BTC/USDT", priceA: 100_000, priceB: 100_010, disagreementBps: 1, agrees: true }],
  problems: paused && reason ? [reason] : [],
  paused,
  reason,
  agreeSinceMs,
  resumeInMs: null,
  change: null,
});

describe("API-02 /health reports feeds and exchange", () => {
  it("API-02 before the feed process runs: feeds unknown, not trusted, exchange not checked", async () => {
    const { get, close } = await start();
    const { body } = await get("/health");
    close();
    expect(body.feeds).toEqual({
      trusted: false,
      paused: true,
      reason: "The feed process has not reported yet.",
      resumeInSec: null,
      resumeAfterSec: null,
      feeds: [
        { id: "A", status: "unknown", lastDataAgoSec: null, detail: "The feed process is not reporting." },
        { id: "B", status: "unknown", lastDataAgoSec: null, detail: "The feed process is not reporting." },
      ],
      pairs: [],
    });
    expect(body.exchange).toEqual({ venue: "binance", status: "unknown", detail: "Not checked yet." });
  });

  it("API-02 with healthy feeds: trusted, per-feed status, per-pair gap", async () => {
    const { db, get, close } = await start();
    writeEvaluation(db, evaluation(false, null), 60);
    db.prepare("INSERT INTO exchange_health VALUES ('binance', 'ok', 0, NULL, 'now')").run();
    const { body } = await get("/health");
    close();
    expect(body.feeds.trusted).toBe(true);
    expect(body.feeds.feeds.map((f: { status: string }) => f.status)).toEqual(["ok", "ok"]);
    expect(body.feeds.feeds[0].lastDataAgoSec).toBeGreaterThanOrEqual(1);
    expect(body.feeds.pairs[0]).toEqual({ pair: "BTC/USDT", priceA: 100_000, priceB: 100_010, disagreementBps: 1, agrees: true });
    expect(body.exchange.status).toBe("ok");
  });

  it("API-02 paused with a resume countdown, and a failing exchange explained", async () => {
    const { db, get, close } = await start();
    writeEvaluation(db, { ...evaluation(true, "Feeds agree; waiting before resuming signals", Date.now() - 20_000) }, 60);
    db.prepare("INSERT INTO exchange_health VALUES ('binance', 'failing', 2, 'HTTP 503', 'now')").run();
    const { body } = await get("/health");
    close();
    expect(body.feeds.paused).toBe(true);
    expect(body.feeds.reason).toBe("Feeds agree; waiting before resuming signals");
    expect(body.feeds.resumeInSec).toBeGreaterThanOrEqual(39);
    expect(body.feeds.resumeInSec).toBeLessThanOrEqual(40);
    expect(body.feeds.resumeAfterSec).toBe(60);
    expect(body.exchange).toEqual({ venue: "binance", status: "failing", detail: "2 failed check(s) in a row: HTTP 503" });
  });

  it("API-02 if the feed process stops writing, the API says so instead of showing old 'ok' data", async () => {
    const { db, get, close } = await start();
    writeEvaluation(db, evaluation(false, null), 60, Date.now() - 30_000);
    const { body } = await get("/health");
    close();
    expect(body.feeds.trusted).toBe(false);
    expect(body.feeds.reason).toBe("The feed process stopped reporting.");
    expect(body.feeds.feeds[0].status).toBe("unknown");
    expect(body.feeds.pairs).toEqual([]);
  });
});

describe("API-02 /prices and /candles", () => {
  it("API-02 /prices returns every pair with both feeds' prices and the gap", async () => {
    const { db, get, close } = await start();
    writePriceState(
      db,
      { pair: "BTC/USDT", bid: 99_999, ask: 100_001, last: 100_000, change24hPct: -1.2, volume24h: 55, timeMs: 0 },
      100_020,
      2,
    );
    const { status, body } = await get("/prices");
    close();
    expect(status).toBe(200);
    expect(body.prices).toEqual([
      {
        pair: "BTC/USDT",
        bid: 99_999,
        ask: 100_001,
        last: 100_000,
        change24hPct: -1.2,
        volume24h: 55,
        checkPrice: 100_020,
        disagreementBps: 2,
        updatedAt: expect.any(String),
        ageSec: expect.any(Number),
      },
    ]);
  });

  it("API-02 /candles returns the latest candles oldest first", async () => {
    const { db, get, close } = await start();
    for (let m = 0; m < 5; m++) {
      upsertCandle(db, FEED_SOURCE, { pair: "BTC/USDT", timeframe: "1m", openTimeMs: m * 60_000, open: m, high: m, low: m, close: m, volume: 1 });
    }
    const { body } = await get("/candles?pair=BTC/USDT&tf=1m&limit=3");
    close();
    expect(body.candles.map((c: { time: number }) => c.time)).toEqual([120_000, 180_000, 240_000]);
    expect(body.candles[0]).toEqual({ time: 120_000, open: 2, high: 2, low: 2, close: 2, volume: 1 });
  });

  it.each([
    ["/candles", /pair like "BTC\/USDT"/],
    ["/candles?pair=BTC/USDT&tf=7m", /Timeframe must be one of: 1m, 15m, 1h, 4h/],
    ["/candles?pair=BTC/USDT&limit=0", /limit must be a whole number from 1 to 1000/],
    ["/candles?pair=BTC/USDT&limit=abc", /limit must be/],
    ["/candles?pair=<script>", /pair like/],
  ])("API-03 %s gives a 400 with a plain-language reason", async (path, message) => {
    const { get, close } = await start();
    const { status, body } = await get(path);
    close();
    expect(status).toBe(400);
    expect(body.error).toMatch(message);
  });
});
