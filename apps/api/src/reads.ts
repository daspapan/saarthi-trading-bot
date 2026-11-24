// Read-only queries behind the GET endpoints. Shapes are documented in README.md.

import { type Db, FEED_MONITOR_MAX_AGE_MS, FEED_SOURCE, type Timeframe, latestCandles, readFeedTrust } from "@saarthi/core";

export type FeedView = {
  id: "A" | "B";
  status: "ok" | "stale" | "down" | "unknown";
  lastDataAgoSec: number | null;
  detail: string;
};

export type FeedsView = {
  trusted: boolean;
  paused: boolean;
  reason: string | null;
  resumeInSec: number | null;
  /** How long the feeds must agree before signals resume (feedResumeSeconds). */
  resumeAfterSec: number | null;
  feeds: FeedView[];
  pairs: { pair: string; priceA: number | null; priceB: number | null; disagreementBps: number | null; agrees: boolean | null }[];
};

export function readFeeds(db: Db, nowMs = Date.now()): FeedsView {
  const trust = readFeedTrust(db, nowMs);
  const mon = db.prepare("SELECT paused, reason, agree_since, resume_after_sec, pairs_json, updated_at FROM feed_monitor WHERE id = 1").get() as
    | { paused: number; reason: string | null; agree_since: string | null; resume_after_sec: number; pairs_json: string; updated_at: string }
    | undefined;
  const monitorFresh = !!mon && nowMs - Date.parse(mon.updated_at) <= FEED_MONITOR_MAX_AGE_MS;

  const rows = db.prepare("SELECT feed, last_tick_at, status, detail FROM feed_health WHERE feed IN ('A', 'B')").all() as {
    feed: "A" | "B";
    last_tick_at: string | null;
    status: "ok" | "stale" | "down";
    detail: string | null;
  }[];
  const byId = new Map(rows.map((r) => [r.feed, r]));
  const feeds: FeedView[] = (["A", "B"] as const).map((id) => {
    const r = byId.get(id);
    if (!r || !monitorFresh) {
      return { id, status: "unknown", lastDataAgoSec: null, detail: "The feed process is not reporting." };
    }
    return {
      id,
      status: r.status,
      lastDataAgoSec: r.last_tick_at ? Math.max(0, Math.round((nowMs - Date.parse(r.last_tick_at)) / 1000)) : null,
      detail: r.detail ?? "",
    };
  });

  let resumeInSec: number | null = null;
  if (mon && monitorFresh && mon.paused && mon.agree_since) {
    resumeInSec = Math.max(0, Math.ceil(mon.resume_after_sec - (nowMs - Date.parse(mon.agree_since)) / 1000));
  }

  return {
    trusted: trust.trusted,
    paused: !trust.trusted,
    reason: trust.reason,
    resumeInSec,
    resumeAfterSec: mon ? mon.resume_after_sec : null,
    feeds,
    pairs: mon && monitorFresh ? JSON.parse(mon.pairs_json) : [],
  };
}

export type ExchangeView = { venue: string; status: "ok" | "failing" | "unavailable" | "unknown"; detail: string };

export function readExchange(db: Db): ExchangeView {
  const r = db.prepare("SELECT venue, status, consecutive_failures, last_error FROM exchange_health WHERE venue = 'binance'").get() as
    | { venue: string; status: "ok" | "failing" | "unavailable"; consecutive_failures: number; last_error: string | null }
    | undefined;
  if (!r) return { venue: "binance", status: "unknown", detail: "Not checked yet." };
  const detail =
    r.status === "ok"
      ? "Binance testnet REST is answering."
      : `${r.consecutive_failures} failed check(s) in a row${r.last_error ? `: ${r.last_error}` : ""}`;
  return { venue: r.venue, status: r.status, detail };
}

export type PriceView = {
  pair: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  change24hPct: number | null;
  volume24h: number | null;
  checkPrice: number | null;
  disagreementBps: number | null;
  updatedAt: string;
  ageSec: number;
};

export function readPrices(db: Db, nowMs = Date.now()): PriceView[] {
  const rows = db
    .prepare(
      "SELECT pair, bid, ask, last, change_24h_pct, volume_24h, check_price, disagreement_bps, updated_at FROM price_state ORDER BY pair",
    )
    .all() as {
    pair: string;
    bid: number | null;
    ask: number | null;
    last: number | null;
    change_24h_pct: number | null;
    volume_24h: number | null;
    check_price: number | null;
    disagreement_bps: number | null;
    updated_at: string;
  }[];
  return rows.map((r) => ({
    pair: r.pair,
    bid: r.bid,
    ask: r.ask,
    last: r.last,
    change24hPct: r.change_24h_pct,
    volume24h: r.volume_24h,
    checkPrice: r.check_price,
    disagreementBps: r.disagreement_bps,
    updatedAt: r.updated_at,
    ageSec: Math.max(0, Math.round((nowMs - Date.parse(r.updated_at)) / 1000)),
  }));
}

export function readCandles(db: Db, pair: string, timeframe: Timeframe, limit: number) {
  return latestCandles(db, FEED_SOURCE, pair, timeframe, limit).map((c) => ({
    time: c.openTimeMs,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
}
