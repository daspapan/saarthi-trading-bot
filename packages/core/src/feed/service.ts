// FeedService: everything the feed process does, minus the actual sockets and
// HTTP calls (those are passed in). Keeping it here makes the whole feed
// testable with a fake clock, fake sockets and a fake exchange.
//
// Timers:
//   every 1 s   close finished minutes, evaluate the two feeds, write health
//   every 5 s   refresh price_state and the in-progress 1m candle
//   every 30 s  exchange REST health check
//   every 5 min look for candle gaps and backfill them

import { appendAudit } from "../audit.ts";
import type { Db } from "../db/db.ts";
import { type BackfillReport, type KlineFetcher, backfillGaps } from "./backfill.ts";
import { CandleAggregator, type Timeframe } from "./candles.ts";
import { ExchangeHealth, HEALTH_CHECK_INTERVAL_MS, runExchangeHealthCheck } from "./exchangeHealth.ts";
import { type Evaluation, type FeedId, FeedMonitor, type MonitorOptions } from "./monitor.ts";
import { type Quote, rollupMinute, upsertCandle, writeEvaluation, writePriceState } from "./store.ts";
import type { FeedEvent } from "./venues.ts";

export const FEED_SOURCE = "binance-testnet";
export const PRICE_STATE_INTERVAL_MS = 5_000;
export const EVALUATE_INTERVAL_MS = 1_000;
export const GAP_CHECK_INTERVAL_MS = 5 * 60_000;

/** How far back to look for gaps, per timeframe (enough history for the indicators). */
export const BACKFILL_WINDOW_MS: Record<"1m" | "15m" | "4h", number> = {
  "1m": 24 * 60 * 60_000,
  "15m": 35 * 24 * 60 * 60_000,
  "4h": 35 * 24 * 60 * 60_000,
};

type Log = {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

export type FeedServiceDeps = {
  db: Db;
  pairs: readonly string[];
  monitor: MonitorOptions;
  parseA: (text: string) => FeedEvent[];
  parseB: (text: string) => FeedEvent[];
  fetchKlines: KlineFetcher;
  pingExchange: () => Promise<void>;
  log: Log;
  now?: () => number;
  venue?: string;
};

export class FeedService {
  readonly monitor: FeedMonitor;
  readonly aggregator = new CandleAggregator();
  readonly exchange = new ExchangeHealth();
  private quotes = new Map<string, Quote>();
  private checkPrices = new Map<string, number>();
  private lastEvaluation: Evaluation | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private aConnects = 0;
  private deps: FeedServiceDeps;
  private now: () => number;
  private venue: string;

  constructor(deps: FeedServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.venue = deps.venue ?? "binance";
    this.monitor = new FeedMonitor(deps.monitor);
  }

  // ---------- inputs from the two sockets ----------

  handleFeedA(text: string): void {
    const now = this.now();
    for (const ev of this.deps.parseA(text)) {
      if (ev.kind === "trade") {
        const { tick } = ev;
        const result = this.aggregator.addTick(tick);
        if (result.ignored) continue;
        for (const c of result.closed) this.storeClosedMinute(c);
        // Staleness uses our own receive time, so a skewed exchange clock can't hide a dead feed.
        this.monitor.recordPrice("A", tick.pair, tick.price, now);
        const q = this.quotes.get(tick.pair);
        this.quotes.set(tick.pair, {
          pair: tick.pair,
          bid: q?.bid ?? null,
          ask: q?.ask ?? null,
          change24hPct: q?.change24hPct ?? null,
          volume24h: q?.volume24h ?? null,
          last: tick.price,
          timeMs: now,
        });
      } else if (ev.kind === "quote") {
        this.quotes.set(ev.quote.pair, { ...ev.quote, timeMs: now });
        this.monitor.recordPrice("A", ev.quote.pair, ev.quote.last, now);
      }
    }
  }

  handleFeedB(text: string): void {
    const now = this.now();
    for (const ev of this.deps.parseB(text)) {
      if (ev.kind === "price") {
        this.checkPrices.set(ev.pair, ev.price);
        this.monitor.recordPrice("B", ev.pair, ev.price, now);
      }
    }
  }

  setConnected(feed: FeedId, connected: boolean, detail: string): void {
    this.monitor.setConnected(feed, connected, detail);
    // A dropped socket means the minute in progress is incomplete: forget it,
    // so the gap is filled from REST rather than with made-up flat candles.
    if (feed === "A" && !connected) this.aggregator.reset();
    if (feed === "A" && connected) {
      this.aConnects += 1;
      // After a reconnect, minutes may be missing: fill them from REST.
      if (this.aConnects > 1) void this.backfillTimeframe("1m", 2 * 60 * 60_000);
    }
  }

  // ---------- periodic work (public so tests can drive them directly) ----------

  private storeClosedMinute(c: Parameters<typeof upsertCandle>[2]): void {
    upsertCandle(this.deps.db, FEED_SOURCE, c);
    rollupMinute(this.deps.db, FEED_SOURCE, c.pair, c.openTimeMs);
  }

  evaluateNow(): Evaluation {
    const now = this.now();
    for (const pair of this.deps.pairs) {
      for (const c of this.aggregator.closeIfDue(pair, now)) this.storeClosedMinute(c);
    }
    const ev = this.monitor.evaluate(now);
    writeEvaluation(this.deps.db, ev, Math.round(this.deps.monitor.resumeMs / 1000), now);
    if (ev.change === "paused") {
      this.deps.log.warn({ problems: ev.problems }, `Health alarm: new signals paused. ${ev.reason}`);
      appendAudit(this.deps.db, "health_alarm", "feed", { kind: "feeds_paused", problems: ev.problems, pairs: ev.pairs });
    } else if (ev.change === "resumed") {
      this.deps.log.info({}, "Feeds agree again: signals resumed.");
      appendAudit(this.deps.db, "health_resumed", "feed", { kind: "feeds_resumed", pairs: ev.pairs });
    }
    this.lastEvaluation = ev;
    return ev;
  }

  refreshPriceState(): number {
    const now = this.now();
    let written = 0;
    const pairChecks = new Map((this.lastEvaluation?.pairs ?? []).map((p) => [p.pair, p.disagreementBps]));
    for (const pair of this.deps.pairs) {
      const q = this.quotes.get(pair);
      if (!q) continue;
      writePriceState(this.deps.db, q, this.checkPrices.get(pair) ?? null, pairChecks.get(pair) ?? null, now);
      const live = this.aggregator.currentCandle(pair);
      if (live) upsertCandle(this.deps.db, FEED_SOURCE, live); // lets the chart show the minute in progress
      written += 1;
    }
    return written;
  }

  async checkExchange() {
    const t = await runExchangeHealthCheck(this.deps.db, this.venue, this.exchange, this.deps.pingExchange);
    if (t === "unavailable") {
      this.deps.log.warn({ lastError: this.exchange.lastError }, `Health alarm: ${this.venue} unavailable, pending signals discarded.`);
    } else if (t === "recovered") {
      this.deps.log.info({}, `${this.venue} is reachable again.`);
    }
    return t;
  }

  async backfillTimeframe(timeframe: Timeframe, windowMs: number): Promise<BackfillReport[]> {
    const now = this.now();
    const reports: BackfillReport[] = [];
    for (const pair of this.deps.pairs) {
      try {
        const r = await backfillGaps(this.deps.db, FEED_SOURCE, pair, timeframe, now - windowMs, now, this.deps.fetchKlines);
        if (r.gaps.length) {
          this.deps.log.info(
            { pair, timeframe, gaps: r.gaps.length, filled: r.filled },
            `Found ${r.gaps.length} gap(s) in ${pair} ${timeframe} candles, filled ${r.filled}.`,
          );
        }
        reports.push(r);
      } catch (err) {
        this.deps.log.error({ pair, timeframe, err: (err as Error).message }, "Backfill failed; will retry later.");
      }
    }
    return reports;
  }

  async backfillAll(): Promise<BackfillReport[]> {
    const out: BackfillReport[] = [];
    for (const tf of ["1m", "15m", "4h"] as const) out.push(...(await this.backfillTimeframe(tf, BACKFILL_WINDOW_MS[tf])));
    return out;
  }

  // ---------- lifecycle ----------

  start(): void {
    this.evaluateNow();
    void this.checkExchange();
    void this.backfillAll();
    this.timers.push(
      setInterval(() => this.evaluateNow(), EVALUATE_INTERVAL_MS),
      setInterval(() => this.refreshPriceState(), PRICE_STATE_INTERVAL_MS),
      setInterval(() => void this.checkExchange(), HEALTH_CHECK_INTERVAL_MS),
      setInterval(() => void this.backfillTimeframe("1m", 2 * 60 * 60_000), GAP_CHECK_INTERVAL_MS),
    );
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** One-line summary for the heartbeat detail. */
  summary(): string {
    const ev = this.lastEvaluation;
    if (!ev) return "starting";
    return `A ${ev.feeds.A.status}, B ${ev.feeds.B.status}, ${ev.paused ? "signals paused" : "signals allowed"}, exchange ${this.exchange.status}`;
  }
}

