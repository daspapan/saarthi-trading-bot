-- 002_feeds.sql: what phase 2 (market data) needs on top of 001.

-- Feed B's latest price and the gap between the feeds, shown next to each pair.
ALTER TABLE price_state ADD COLUMN check_price REAL;
ALTER TABLE price_state ADD COLUMN disagreement_bps REAL;

-- Which exchange a queued order is for, so an exchange outage can discard only its signals.
ALTER TABLE order_queue ADD COLUMN venue TEXT NOT NULL DEFAULT 'binance';

-- One row (id = 1): the feed process's current verdict on data quality.
-- Anything that trusts prices must also check updated_at: if the feed process
-- stops writing, an old "all good" row must not be believed (see readFeedTrust).
CREATE TABLE feed_monitor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  paused INTEGER NOT NULL,            -- 1 = new signals paused
  reason TEXT,                        -- plain language, shown in the UI
  agree_since TEXT,                   -- when the feeds started agreeing again (resume countdown)
  resume_after_sec INTEGER NOT NULL,  -- feedResumeSeconds at the time of writing
  pairs_json TEXT NOT NULL,           -- [{ pair, priceA, priceB, disagreementBps }]
  updated_at TEXT NOT NULL
);

-- Health of each exchange's REST API (checked every 30 s).
CREATE TABLE exchange_health (
  venue TEXT PRIMARY KEY,             -- 'binance' (later 'bybit')
  status TEXT NOT NULL,               -- 'ok', 'failing', 'unavailable'
  consecutive_failures INTEGER NOT NULL,
  last_error TEXT,
  checked_at TEXT NOT NULL
);
