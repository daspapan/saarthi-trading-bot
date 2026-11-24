// Database reads and writes for market data. Writes are upserts keyed on the
// natural key, so writing the same candle twice (after a reconnect or a
// backfill overlap) never creates a duplicate row.

import type { Db } from "../db/db.ts";
import { type Candle, ROLLUP_TIMEFRAMES, TIMEFRAMES, type Timeframe, bucketStart, rollup } from "./candles.ts";
import type { Evaluation } from "./monitor.ts";

export function upsertCandle(db: Db, source: string, c: Candle): void {
  db.prepare(
    `INSERT INTO candles (source, pair, timeframe, open_time_ms, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, pair, timeframe, open_time_ms) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, volume = excluded.volume`,
  ).run(source, c.pair, c.timeframe, c.openTimeMs, c.open, c.high, c.low, c.close, c.volume);
}

type CandleRow = {
  pair: string;
  timeframe: Timeframe;
  open_time_ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const toCandle = (r: CandleRow): Candle => ({
  pair: r.pair,
  timeframe: r.timeframe,
  openTimeMs: r.open_time_ms,
  open: r.open,
  high: r.high,
  low: r.low,
  close: r.close,
  volume: r.volume,
});

/** Candles in [fromMs, toMs), oldest first. */
export function loadCandles(db: Db, source: string, pair: string, timeframe: Timeframe, fromMs: number, toMs: number): Candle[] {
  const rows = db
    .prepare(
      `SELECT pair, timeframe, open_time_ms, open, high, low, close, volume FROM candles
       WHERE source = ? AND pair = ? AND timeframe = ? AND open_time_ms >= ? AND open_time_ms < ?
       ORDER BY open_time_ms`,
    )
    .all(source, pair, timeframe, fromMs, toMs) as CandleRow[];
  return rows.map(toCandle);
}

/** The most recent `limit` candles, oldest first. */
export function latestCandles(db: Db, source: string, pair: string, timeframe: Timeframe, limit: number): Candle[] {
  const rows = db
    .prepare(
      `SELECT pair, timeframe, open_time_ms, open, high, low, close, volume FROM candles
       WHERE source = ? AND pair = ? AND timeframe = ? ORDER BY open_time_ms DESC LIMIT ?`,
    )
    .all(source, pair, timeframe, limit) as CandleRow[];
  return rows.map(toCandle).reverse();
}

/**
 * After a 1m candle is stored, rebuild the 15m and 4h candles it belongs to
 * from the stored 1m candles. Rebuilding (instead of adding) keeps this
 * correct even if the same minute is written twice.
 */
export function rollupMinute(db: Db, source: string, pair: string, minuteOpenMs: number): Candle[] {
  const out: Candle[] = [];
  for (const tf of ROLLUP_TIMEFRAMES) {
    const start = bucketStart(minuteOpenMs, tf);
    const minutes = loadCandles(db, source, pair, "1m", start, start + TIMEFRAMES[tf]);
    // Only rebuild from a complete run of minutes (bucket start up to the latest
    // minute, no holes). Otherwise a partial rollup could overwrite a correct
    // candle that was backfilled from the exchange.
    const latest = minutes.at(-1);
    const expected = latest ? (latest.openTimeMs - start) / TIMEFRAMES["1m"] + 1 : 0;
    if (!latest || minutes[0]!.openTimeMs !== start || minutes.length !== expected) continue;
    for (const c of rollup(minutes, tf)) {
      upsertCandle(db, source, c);
      out.push(c);
    }
  }
  return out;
}

export function setRiskFlag(db: Db, name: string, active: boolean, reason: string | null, nowMs = Date.now()): void {
  db.prepare(
    `INSERT INTO risk_flags (name, active, reason, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET active = excluded.active, reason = excluded.reason, updated_at = excluded.updated_at`,
  ).run(name, active ? 1 : 0, reason, new Date(nowMs).toISOString());
}

export function getRiskFlag(db: Db, name: string): { active: boolean; reason: string | null } {
  const row = db.prepare("SELECT active, reason FROM risk_flags WHERE name = ?").get(name) as
    | { active: number; reason: string | null }
    | undefined;
  return { active: row?.active === 1, reason: row?.reason ?? null };
}

export type Quote = {
  pair: string;
  bid: number | null;
  ask: number | null;
  last: number;
  change24hPct: number | null;
  volume24h: number | null;
  timeMs: number;
};

export function writePriceState(
  db: Db,
  q: Quote,
  checkPrice: number | null,
  disagreement: number | null,
  nowMs = Date.now(),
): void {
  db.prepare(
    `INSERT INTO price_state (pair, bid, ask, last, change_24h_pct, volume_24h, updated_at, check_price, disagreement_bps)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET bid = excluded.bid, ask = excluded.ask, last = excluded.last,
       change_24h_pct = excluded.change_24h_pct, volume_24h = excluded.volume_24h, updated_at = excluded.updated_at,
       check_price = excluded.check_price, disagreement_bps = excluded.disagreement_bps`,
  ).run(q.pair, q.bid, q.ask, q.last, q.change24hPct, q.volume24h, new Date(nowMs).toISOString(), checkPrice, disagreement);
}

/** Writes the monitor's verdict: feed_health rows, the feed_monitor row and the feeds_paused flag. */
export function writeEvaluation(db: Db, ev: Evaluation, resumeAfterSec: number, nowMs = Date.now()): void {
  const now = new Date(nowMs).toISOString();
  const feedStmt = db.prepare(
    `INSERT INTO feed_health (feed, last_tick_at, status, detail, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(feed) DO UPDATE SET last_tick_at = excluded.last_tick_at, status = excluded.status,
       detail = excluded.detail, updated_at = excluded.updated_at`,
  );
  for (const id of ["A", "B"] as const) {
    const f = ev.feeds[id];
    feedStmt.run(id, f.lastDataMs ? new Date(f.lastDataMs).toISOString() : null, f.status, f.detail, now);
  }
  db.prepare(
    `INSERT INTO feed_monitor (id, paused, reason, agree_since, resume_after_sec, pairs_json, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, reason = excluded.reason, agree_since = excluded.agree_since,
       resume_after_sec = excluded.resume_after_sec, pairs_json = excluded.pairs_json, updated_at = excluded.updated_at`,
  ).run(
    ev.paused ? 1 : 0,
    ev.reason,
    ev.agreeSinceMs ? new Date(ev.agreeSinceMs).toISOString() : null,
    resumeAfterSec,
    JSON.stringify(ev.pairs),
    now,
  );
  setRiskFlag(db, "feeds_paused", ev.paused, ev.reason, nowMs);
}

/** If the feed process has not written for this long, its verdict is not trusted. */
export const FEED_MONITOR_MAX_AGE_MS = 15_000;

export type FeedTrust = { trusted: boolean; reason: string | null };

/**
 * The one question the analyst and validator ask: "can I trust prices right now?"
 * Fails closed: no row, an old row (feed process stopped) or a paused row all mean no.
 */
export function readFeedTrust(db: Db, nowMs = Date.now()): FeedTrust {
  const row = db.prepare("SELECT paused, reason, updated_at FROM feed_monitor WHERE id = 1").get() as
    | { paused: number; reason: string | null; updated_at: string }
    | undefined;
  if (!row) return { trusted: false, reason: "The feed process has not reported yet." };
  if (nowMs - Date.parse(row.updated_at) > FEED_MONITOR_MAX_AGE_MS) {
    return { trusted: false, reason: "The feed process stopped reporting." };
  }
  if (row.paused) return { trusted: false, reason: row.reason ?? "Feeds paused." };
  return { trusted: true, reason: null };
}
