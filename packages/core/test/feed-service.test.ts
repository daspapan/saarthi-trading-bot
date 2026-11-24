import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Candle,
  FEED_SOURCE,
  FeedService,
  type KlineFetcher,
  ReconnectingSocket,
  type WsLike,
  backfillGaps,
  backoffDelay,
  binanceParser,
  bybitParser,
  getRiskFlag,
  loadCandles,
  readFeedTrust,
  upsertCandle,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const MIN = 60_000;
const PAIRS = ["BTC/USDT", "ETH/USDT"];

// ---------- fake exchange messages ----------

let tradeId = 0;
const trade = (pair: string, price: number, qty: number, timeMs: number, id = ++tradeId) =>
  JSON.stringify({ e: "trade", s: pair.replace("/", ""), t: id, p: String(price), q: String(qty), T: timeMs });

const ticker = (pair: string, last: number, timeMs: number) =>
  JSON.stringify({
    e: "24hrTicker",
    E: timeMs,
    s: pair.replace("/", ""),
    b: String(last - 1),
    a: String(last + 1),
    c: String(last),
    P: "-1.25",
    v: "1234.5",
  });

const bybit = (pair: string, price: number, ts: number) =>
  JSON.stringify({ topic: `tickers.${pair.replace("/", "")}`, ts, data: { symbol: pair.replace("/", ""), lastPrice: String(price) } });

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeService(opts: { fetchKlines?: KlineFetcher; ping?: () => Promise<void> } = {}) {
  const { db } = tempDb();
  const clock = { now: T0 };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new FeedService({
    db,
    pairs: PAIRS,
    monitor: { pairs: PAIRS, staleMs: 15_000, disagreementBps: 50, resumeMs: 60_000 },
    parseA: binanceParser(PAIRS),
    parseB: bybitParser(PAIRS),
    fetchKlines: opts.fetchKlines ?? (async () => []),
    pingExchange: opts.ping ?? (async () => {}),
    log,
    now: () => clock.now,
  });
  service.setConnected("A", true, "up");
  service.setConnected("B", true, "up");
  /** Both feeds report agreeing prices at the current clock time. */
  const tickAll = (btcB = 100_000) => {
    service.handleFeedA(ticker("BTC/USDT", 100_000, clock.now));
    service.handleFeedA(ticker("ETH/USDT", 3_000, clock.now));
    service.handleFeedB(bybit("BTC/USDT", btcB, clock.now));
    service.handleFeedB(bybit("ETH/USDT", 3_000, clock.now));
  };
  /** Advance the clock second by second, feeding data and evaluating, like the real 1 s timer. */
  const run = (seconds: number, btcB = 100_000) => {
    for (let i = 0; i < seconds; i++) {
      clock.now += 1_000;
      tickAll(btcB);
      service.evaluateNow();
    }
  };
  return { db, clock, log, service, tickAll, run };
}

const auditTypes = (db: ReturnType<typeof tempDb>["db"]) =>
  (db.prepare("SELECT event_type, payload_json FROM audit_log ORDER BY id").all() as { event_type: string; payload_json: string }[]).map(
    (r) => `${r.event_type}:${JSON.parse(r.payload_json).kind}`,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe("FEED-02 price_state refresh", () => {
  it("FEED-02 writes bid, ask, last, 24h change, volume, feed B's price and the gap for every pair", () => {
    const { db, service, run } = makeService();
    run(2, 100_010);
    expect(service.refreshPriceState()).toBe(2);
    const row = db.prepare("SELECT * FROM price_state WHERE pair = 'BTC/USDT'").get() as Record<string, unknown>;
    expect(row).toMatchObject({
      bid: 99_999,
      ask: 100_001,
      last: 100_000,
      change_24h_pct: -1.25,
      volume_24h: 1234.5,
      check_price: 100_010,
      disagreement_bps: 1,
    });
  });

  it("FEED-02 refreshes every 5 seconds once started", () => {
    vi.useFakeTimers({ now: T0 });
    const { db, service, tickAll } = makeService();
    const spy = vi.spyOn(service, "refreshPriceState");
    service.start();
    tickAll();
    vi.advanceTimersByTime(4_999);
    expect(spy).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(spy).toHaveBeenCalledTimes(3);
    service.stop();
    vi.advanceTimersByTime(20_000);
    expect(spy).toHaveBeenCalledTimes(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM price_state").get() as { n: number }).n).toBe(2);
  });

  it("FEED-02 uses the latest trade as 'last' when it is newer than the ticker", () => {
    const { db, clock, service, run } = makeService();
    run(1);
    service.handleFeedA(trade("BTC/USDT", 100_123, 0.5, clock.now));
    service.refreshPriceState();
    expect((db.prepare("SELECT last, bid FROM price_state WHERE pair = 'BTC/USDT'").get() as { last: number; bid: number })).toEqual({
      last: 100_123,
      bid: 99_999,
    });
  });

  it("FEED-02 a pair with no data yet is skipped, not written as zeros", () => {
    const { db, service } = makeService();
    expect(service.refreshPriceState()).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM price_state").get() as { n: number }).n).toBe(0);
  });
});

describe("FEED-03 stale feed in the database: flag, alarm, trust", () => {
  it("FEED-03 a silent feed B sets feeds_paused, writes stale health and one audited alarm", () => {
    const { db, clock, service, run } = makeService();
    run(61);
    expect(readFeedTrust(db, clock.now).trusted).toBe(true);
    expect(getRiskFlag(db, "feeds_paused").active).toBe(false);

    // From now on only feed A talks.
    for (let i = 0; i < 16; i++) {
      clock.now += 1_000;
      service.handleFeedA(ticker("BTC/USDT", 100_000, clock.now));
      service.handleFeedA(ticker("ETH/USDT", 3_000, clock.now));
      service.evaluateNow();
    }
    expect(getRiskFlag(db, "feeds_paused")).toEqual({ active: true, reason: expect.stringMatching(/Feed B has no data/) });
    expect(db.prepare("SELECT status FROM feed_health WHERE feed = 'B'").get()).toEqual({ status: "stale" });
    expect(readFeedTrust(db, clock.now)).toEqual({ trusted: false, reason: expect.stringMatching(/Feed B/) });
    expect(auditTypes(db)).toEqual(["health_resumed:feeds_resumed", "health_alarm:feeds_paused"]);
  });

  it("FEED-03 the price check fails closed when the feed process stops writing", () => {
    const { db, clock, run } = makeService();
    run(61);
    expect(readFeedTrust(db, clock.now).trusted).toBe(true);
    expect(readFeedTrust(db, clock.now + 15_001)).toEqual({ trusted: false, reason: "The feed process stopped reporting." });
  });

  it("FEED-03 before the feed process has ever run, prices are not trusted", () => {
    const { db } = tempDb();
    expect(readFeedTrust(db).trusted).toBe(false);
  });
});

describe("FEED-04 and FEED-05 through the service", () => {
  it("FEED-04 disagreement pauses; FEED-05 agreement for 60 s resumes, each audited once", () => {
    const { db, clock, run } = makeService();
    run(61);
    run(3, 100_000 * 1.006); // 60 bps
    expect(readFeedTrust(db, clock.now).trusted).toBe(false);
    run(60); // 60 checks = 59 s since the first agreeing check
    expect(readFeedTrust(db, clock.now).trusted).toBe(false);
    run(1); // 60 s of agreement
    expect(readFeedTrust(db, clock.now).trusted).toBe(true);
    expect(auditTypes(db)).toEqual(["health_resumed:feeds_resumed", "health_alarm:feeds_paused", "health_resumed:feeds_resumed"]);
  });
});

describe("FEED-06 reconnect with backoff, no duplicate candles", () => {
  class FakeSocket implements WsLike {
    static all: FakeSocket[] = [];
    sent: string[] = [];
    onopen: WsLike["onopen"] = null;
    onmessage: WsLike["onmessage"] = null;
    onclose: WsLike["onclose"] = null;
    onerror: WsLike["onerror"] = null;
    constructor() {
      FakeSocket.all.push(this);
    }
    send(d: string) {
      this.sent.push(d);
    }
    close() {
      this.onclose?.();
    }
  }

  it("FEED-06 backoff doubles from 1 s and caps at 30 s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a))).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("FEED-06 reconnects after 1 s, 2 s, 4 s, resubscribes each time, and resets after data flows", () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    const statuses: boolean[] = [];
    const sock = new ReconnectingSocket({
      name: "A",
      url: "wss://x",
      createSocket: () => new FakeSocket(),
      onOpen: (send) => send({ op: "subscribe" }),
      onMessage: () => {},
      onStatus: (up) => statuses.push(up),
    });
    sock.start();
    FakeSocket.all[0]!.onopen?.();
    expect(FakeSocket.all[0]!.sent).toEqual(['{"op":"subscribe"}']);

    FakeSocket.all[0]!.onclose?.();
    expect(sock.lastDelayMs).toBe(1_000);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);

    FakeSocket.all[1]!.onclose?.(); // failed again without any data
    expect(sock.lastDelayMs).toBe(2_000);
    vi.advanceTimersByTime(2_000);
    FakeSocket.all[2]!.onclose?.();
    expect(sock.lastDelayMs).toBe(4_000);
    vi.advanceTimersByTime(4_000);

    const s3 = FakeSocket.all[3]!;
    s3.onopen?.();
    expect(s3.sent).toEqual(['{"op":"subscribe"}']); // resubscribed after reconnect
    s3.onmessage?.({ data: "{}" }); // data flowed: next drop starts at 1 s again
    s3.onclose?.();
    expect(sock.lastDelayMs).toBe(1_000);
    expect(statuses).toEqual([true, false, false, false, true, false]);
    expect(sock.connectCount).toBe(2);
    sock.stop();
  });

  it("FEED-06 stop() cancels a pending reconnect and the ping timer", () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    const sock = new ReconnectingSocket({
      name: "B",
      url: "wss://x",
      createSocket: () => new FakeSocket(),
      onOpen: () => {},
      onMessage: () => {},
      onStatus: () => {},
      ping: { message: { op: "ping" }, everyMs: 20_000 },
    });
    sock.start();
    FakeSocket.all[0]!.onopen?.();
    vi.advanceTimersByTime(40_000);
    expect(FakeSocket.all[0]!.sent).toEqual(['{"op":"ping"}', '{"op":"ping"}']);
    sock.stop();
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("FEED-06 a socket that throws while opening is retried with backoff", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const sock = new ReconnectingSocket({
      name: "A",
      url: "wss://x",
      createSocket: () => {
        attempts += 1;
        throw new Error("DNS failure");
      },
      onOpen: () => {},
      onMessage: () => {},
      onStatus: () => {},
    });
    sock.start();
    vi.advanceTimersByTime(1_000 + 2_000 + 4_000);
    expect(attempts).toBe(4);
    sock.stop();
  });

  it("FEED-06 trades replayed after a reconnect are not counted twice, and no candle row is duplicated", () => {
    const { db, clock, service } = makeService();
    clock.now = T0 + 10_000;
    const replay = [trade("BTC/USDT", 100, 1, T0 + 1_000, 1), trade("BTC/USDT", 101, 2, T0 + 2_000, 2)];
    for (const m of replay) service.handleFeedA(m);

    service.setConnected("A", false, "socket closed");
    service.setConnected("A", true, "reconnected");
    for (const m of replay) service.handleFeedA(m); // the exchange resends the same trades
    service.handleFeedA(trade("BTC/USDT", 102, 1, T0 + MIN + 1_000, 3));
    service.handleFeedA(trade("BTC/USDT", 103, 1, T0 + 2 * MIN + 1_000, 4)); // closes minute 1

    const minutes = loadCandles(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 3 * MIN);
    // Minute 0 was incomplete when the socket dropped, so it is left for the backfill instead of stored half-built.
    expect(minutes).toEqual([{ pair: "BTC/USDT", timeframe: "1m", openTimeMs: T0 + MIN, open: 102, high: 102, low: 102, close: 102, volume: 1 }]);

    // Writing the in-progress candle many times (every 5 s) still leaves one row.
    clock.now = T0 + 2 * MIN + 30_000;
    service.handleFeedA(ticker("BTC/USDT", 103, clock.now));
    service.refreshPriceState();
    service.refreshPriceState();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM candles WHERE timeframe = '1m' AND open_time_ms = ?").get(T0 + 2 * MIN) as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it("FEED-06 a reconnect triggers a backfill of the last 2 hours of 1m candles", async () => {
    const calls: [string, string][] = [];
    const { service } = makeService({
      fetchKlines: async (pair, tf) => {
        calls.push([pair, tf]);
        return [];
      },
    });
    service.setConnected("A", false, "down");
    service.setConnected("A", true, "up");
    await vi.waitFor(() => expect(calls).toEqual([["BTC/USDT", "1m"], ["ETH/USDT", "1m"]]));
  });
});

describe("FEED-07 exchange health", () => {
  it("FEED-07 two failures are 'failing', the third marks it unavailable, discards its pending signals and alarms once", async () => {
    let up = false;
    const { db, service } = makeService({ ping: async () => (up ? undefined : Promise.reject(new Error("HTTP 503"))) });
    db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES ('BTC/USDT', 'long', '{}', 'test', 'x')").run();
    const insertQueue = db.prepare(
      "INSERT INTO order_queue (dedupe_id, signal_id, pair, payload_json, venue, created_at) VALUES (?, 1, 'BTC/USDT', '{}', ?, 'x')",
    );
    insertQueue.run("a", "binance");
    insertQueue.run("b", "binance");
    insertQueue.run("c", "bybit");

    expect(await service.checkExchange()).toBeNull();
    expect(await service.checkExchange()).toBeNull();
    expect(service.exchange.status).toBe("failing");
    expect(db.prepare("SELECT COUNT(*) AS n FROM order_queue WHERE status = 'pending'").get()).toEqual({ n: 3 });

    expect(await service.checkExchange()).toBe("unavailable");
    expect(db.prepare("SELECT status, consecutive_failures, last_error FROM exchange_health").get()).toEqual({
      status: "unavailable",
      consecutive_failures: 3,
      last_error: "HTTP 503",
    });
    const queue = db.prepare("SELECT dedupe_id, status FROM order_queue ORDER BY id").all();
    expect(queue).toEqual([
      { dedupe_id: "a", status: "discarded" },
      { dedupe_id: "b", status: "discarded" },
      { dedupe_id: "c", status: "pending" }, // other venue untouched
    ]);
    expect(getRiskFlag(db, "exchange_unavailable").active).toBe(true);

    expect(await service.checkExchange()).toBeNull(); // a 4th failure doesn't alarm again
    up = true;
    expect(await service.checkExchange()).toBe("recovered");
    expect(getRiskFlag(db, "exchange_unavailable").active).toBe(false);
    expect(auditTypes(db)).toEqual(["health_alarm:exchange_unavailable", "health_resumed:exchange_available"]);
  });

  it("FEED-07 a success in between resets the count, so three non-consecutive failures do nothing", async () => {
    const results = [false, false, true, false, false];
    const { service } = makeService({ ping: async () => (results.shift() ? undefined : Promise.reject(new Error("timeout"))) });
    for (let i = 0; i < 5; i++) await service.checkExchange();
    expect(service.exchange.status).toBe("failing");
    expect(service.exchange.consecutiveFailures).toBe(2);
  });

  it("FEED-07 runs every 30 seconds once started", async () => {
    vi.useFakeTimers({ now: T0 });
    let pings = 0;
    const { service } = makeService({
      ping: async () => {
        pings += 1;
      },
    });
    service.start(); // checks once immediately
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pings).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pings).toBe(2);
    service.stop();
  });
});

describe("FEED-08 gaps are back-filled from REST", () => {
  const restCandle = (minute: number, price: number): Candle => ({
    pair: "BTC/USDT",
    timeframe: "1m",
    openTimeMs: T0 + minute * MIN,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1,
  });

  it("FEED-08 asks REST for exactly the missing ranges and stores what comes back", async () => {
    const { db } = tempDb();
    for (const m of [0, 1, 4, 5]) upsertCandle(db, FEED_SOURCE, restCandle(m, 100 + m));
    const asked: [number, number][] = [];
    const fetcher: KlineFetcher = async (_pair, _tf, start, end) => {
      asked.push([(start - T0) / MIN, (end - T0) / MIN]);
      const out: Candle[] = [];
      for (let t = start; t < end; t += MIN) out.push(restCandle((t - T0) / MIN, 200));
      return out;
    };
    const report = await backfillGaps(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 8 * MIN + 30_000, fetcher);
    expect(asked).toEqual([
      [2, 4],
      [6, 8],
    ]); // minute 8 is still in progress, so it is not requested
    expect(report.filled).toBe(4);
    expect(loadCandles(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 8 * MIN).map((c) => (c.openTimeMs - T0) / MIN)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("FEED-08 candles outside the requested gap or off the minute grid are ignored", async () => {
    const { db } = tempDb();
    const fetcher: KlineFetcher = async () => [
      restCandle(-5, 1), // before the gap
      { ...restCandle(1, 1), openTimeMs: T0 + MIN + 7 }, // not on the grid
      restCandle(2, 1), // good
    ];
    const report = await backfillGaps(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 3 * MIN, fetcher);
    expect(report.filled).toBe(1);
  });

  it("FEED-08 a full set of minutes needs no REST call", async () => {
    const { db } = tempDb();
    for (let m = 0; m < 5; m++) upsertCandle(db, FEED_SOURCE, restCandle(m, 100));
    const fetcher = vi.fn(async () => []);
    await backfillGaps(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 5 * MIN, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("FEED-08 back-filled minutes also rebuild the 15m candle", async () => {
    const { db } = tempDb();
    const fetcher: KlineFetcher = async (_p, _tf, start, end) => {
      const out: Candle[] = [];
      for (let t = start; t < end; t += MIN) out.push(restCandle((t - T0) / MIN, 100 + (t - T0) / MIN));
      return out;
    };
    await backfillGaps(db, FEED_SOURCE, "BTC/USDT", "1m", T0, T0 + 15 * MIN, fetcher);
    expect(loadCandles(db, FEED_SOURCE, "BTC/USDT", "15m", T0, T0 + 1)).toEqual([
      { pair: "BTC/USDT", timeframe: "15m", openTimeMs: T0, open: 100, high: 114, low: 100, close: 114, volume: 15 },
    ]);
  });

  it("FEED-08 at startup the service backfills 1m, 15m and 4h for every pair; a failing REST call is logged, not thrown", async () => {
    const calls: string[] = [];
    const { service, log } = makeService({
      fetchKlines: async (pair, tf) => {
        calls.push(`${pair} ${tf}`);
        if (pair === "ETH/USDT" && tf === "15m") throw new Error("HTTP 429");
        return [];
      },
    });
    const reports = await service.backfillAll();
    expect(new Set(calls)).toEqual(
      new Set(["BTC/USDT 1m", "ETH/USDT 1m", "BTC/USDT 15m", "ETH/USDT 15m", "BTC/USDT 4h", "ETH/USDT 4h"]),
    );
    expect(reports).toHaveLength(5);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ pair: "ETH/USDT", err: "HTTP 429" }), expect.any(String));
  });
});

describe("Feed process summary", () => {
  it("FEED-03 the heartbeat detail says plainly whether signals are allowed", () => {
    const { service, run } = makeService();
    expect(service.summary()).toBe("starting");
    run(61);
    expect(service.summary()).toBe("A ok, B ok, signals allowed, exchange ok");
  });
});

void silentLog;
