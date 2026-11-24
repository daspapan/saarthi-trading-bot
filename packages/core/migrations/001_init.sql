-- 001_init.sql: every table Saarthi needs. Money and prices are stored as REAL
-- for readability in a demo; amounts are always rounded to exchange rules in code.
-- Times are ISO-8601 UTC strings unless a column name ends in _ms.

-- OHLCV candles from the feed (and downloaded history). One row per pair/timeframe/open time.
CREATE TABLE candles (
  source TEXT NOT NULL,              -- 'binance-testnet', 'price-check', 'binance-history'
  pair TEXT NOT NULL,
  timeframe TEXT NOT NULL,           -- '1m', '15m', '1h', '4h'
  open_time_ms INTEGER NOT NULL,
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume REAL NOT NULL,
  PRIMARY KEY (source, pair, timeframe, open_time_ms)
);

-- Latest price per pair, refreshed every 5 seconds. This is what the analyst reads.
CREATE TABLE price_state (
  pair TEXT PRIMARY KEY,
  bid REAL, ask REAL, last REAL,
  change_24h_pct REAL,
  volume_24h REAL,
  updated_at TEXT NOT NULL
);

-- Heartbeat and agreement status for each price feed.
CREATE TABLE feed_health (
  feed TEXT PRIMARY KEY,             -- 'A' (Binance testnet) or 'B' (public cross-check)
  last_tick_at TEXT,
  status TEXT NOT NULL,              -- 'ok', 'stale', 'down'
  detail TEXT,
  updated_at TEXT NOT NULL
);

-- Each data snapshot the analyst sent to the model, stored by its SHA-256 hash.
CREATE TABLE snapshots (
  hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  json TEXT NOT NULL                 -- canonical JSON (sorted keys)
);

-- Every signal the analyst submitted (one row per pair per run), valid or not.
CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_hash TEXT REFERENCES snapshots(hash),
  pair TEXT NOT NULL,
  direction TEXT NOT NULL,           -- 'long', 'exit', 'neutral'
  candidate_id TEXT,
  confidence TEXT,
  raw_json TEXT NOT NULL,            -- exactly what the model returned
  source TEXT NOT NULL,              -- 'ollama', 'fail-closed', 'demo-forged'
  created_at TEXT NOT NULL
);

-- Result of the guardrails (schema, grounding, injection screen) for a signal.
CREATE TABLE guardrail_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  passed INTEGER NOT NULL,           -- 0 or 1
  reasons_json TEXT NOT NULL,        -- list of plain-language reasons
  created_at TEXT NOT NULL
);

-- The validator's full rule list for a signal (every rule, not just the first failure).
CREATE TABLE validator_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  passed INTEGER NOT NULL,
  rules_json TEXT NOT NULL,          -- [{ rule, passed, message }]
  created_at TEXT NOT NULL
);

-- Signals that passed validation, waiting for the executor. dedupe_id is unique,
-- so inserting the same signal twice is silently ignored (INSERT OR IGNORE).
CREATE TABLE order_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_id TEXT NOT NULL UNIQUE,    -- sha256(signal)
  signal_id INTEGER NOT NULL REFERENCES signals(id),
  pair TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'taken', 'discarded'
  created_at TEXT NOT NULL
);

-- One row per order lifecycle, with its current state-machine state saved after every step.
CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_id INTEGER REFERENCES order_queue(id),
  client_order_id TEXT NOT NULL UNIQUE, -- equals the dedupe_id
  venue TEXT NOT NULL,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,                -- 'buy' or 'sell'
  type TEXT NOT NULL,                -- 'limit' or 'market'
  quantity REAL NOT NULL,
  entry_price REAL,
  stop_price REAL,
  target_price REAL,
  state TEXT NOT NULL,               -- QUEUED ... CLOSED, CANCELLED, FAILED, EMERGENCY_CLOSE
  exchange_order_id TEXT,
  protection_order_id TEXT,
  filled_quantity REAL NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every state change of every order, in order. Drives the animated stepper.
CREATE TABLE order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

-- Individual fills reported by the exchange, with fees.
CREATE TABLE fills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  exchange_trade_id TEXT,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  quantity REAL NOT NULL,
  fee REAL NOT NULL,
  fee_asset TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Open and closed positions (spot: we only ever hold an asset, never owe it).
CREATE TABLE positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair TEXT NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  quantity REAL NOT NULL,
  avg_entry REAL NOT NULL,
  stop_price REAL,
  target_price REAL,
  status TEXT NOT NULL,              -- 'open' or 'closed'
  realised_pnl REAL NOT NULL DEFAULT 0, -- after fees
  fees_paid REAL NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_at TEXT
);

-- Equity over time (USDT). The first row comes from the seed: 10,000 USDT.
CREATE TABLE equity_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equity REAL NOT NULL,
  cash REAL NOT NULL,
  high_water_mark REAL NOT NULL,
  day_start_equity REAL NOT NULL,
  created_at TEXT NOT NULL
);

-- Named on/off flags read by the validator and executor (kill switch, daily limit, ...).
CREATE TABLE risk_flags (
  name TEXT PRIMARY KEY,             -- 'kill_switch', 'manual_restart', 'daily_limit_hit', 'feeds_paused'
  active INTEGER NOT NULL,
  reason TEXT,
  updated_at TEXT NOT NULL
);

-- Every approved settings change: which file, which key, old and new value.
CREATE TABLE settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL,
  key TEXT NOT NULL,
  old_value TEXT NOT NULL,
  new_value TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per backtest run with its parameters and summary metrics.
CREATE TABLE backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  params_json TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  metrics_json TEXT,
  equity_curve_json TEXT,
  created_at TEXT NOT NULL
);

-- The full trade log of each backtest run.
CREATE TABLE backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
  pair TEXT NOT NULL,
  entry_time_ms INTEGER NOT NULL,
  exit_time_ms INTEGER,
  entry_price REAL NOT NULL,
  exit_price REAL,
  quantity REAL NOT NULL,
  fees REAL NOT NULL,
  pnl REAL,
  exit_reason TEXT
);

-- Append-only audit log. Each row stores the hash of the previous row, so editing
-- any row breaks the chain from that point on. Triggers below forbid UPDATE/DELETE.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,          -- 'signal', 'rule_result', 'order_state', 'setting_change', 'kill_switch', 'alert', ...
  actor TEXT NOT NULL,               -- process or 'operator'
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- Liveness of each process. Each worker writes here every few seconds; /health reads it.
-- (Not in the original table list; added so the health strip has something real to show.)
CREATE TABLE process_heartbeats (
  name TEXT PRIMARY KEY,             -- 'api', 'feed', 'analyst', 'executor', 'risk'
  pid INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_beat_at TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX idx_signals_created ON signals(created_at);
CREATE INDEX idx_order_queue_status ON order_queue(status, pair, id);
CREATE INDEX idx_order_events_order ON order_events(order_id, id);
CREATE INDEX idx_positions_status ON positions(status, pair);
