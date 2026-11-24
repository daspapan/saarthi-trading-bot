-- 006_executor.sql: what the executor (phase 6) needs.

-- More detail on each order's life, so the state machine can resume after a crash.
ALTER TABLE orders ADD COLUMN signal_id INTEGER REFERENCES signals(id);
ALTER TABLE orders ADD COLUMN direction TEXT NOT NULL DEFAULT 'long';   -- 'long' (buy, then protect) or 'exit' (sell what we hold)
ALTER TABLE orders ADD COLUMN state_since TEXT;                         -- when the current state began (timeouts)
ALTER TABLE orders ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;      -- tries in the current state (retries)
ALTER TABLE orders ADD COLUMN next_attempt_at TEXT;                     -- backoff: don't retry before this
ALTER TABLE orders ADD COLUMN avg_fill_price REAL;
ALTER TABLE orders ADD COLUMN entry_fee REAL NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN protection_list_id TEXT;                  -- client ID of the OCO protecting the fill
ALTER TABLE orders ADD COLUMN exit_price REAL;
ALTER TABLE orders ADD COLUMN exit_fee REAL;
ALTER TABLE orders ADD COLUMN close_reason TEXT;                        -- 'target', 'stop', 'exit-signal', 'emergency', 'reconciled'
ALTER TABLE orders ADD COLUMN realised_pnl REAL;                        -- after all fees
ALTER TABLE orders ADD COLUMN position_id INTEGER;

-- The simulated paper exchange keeps its own books, like a real exchange would,
-- so an executor crash or restart can be reconciled against it.
CREATE TABLE paper_balances (
  asset TEXT PRIMARY KEY,
  free REAL NOT NULL,
  locked REAL NOT NULL
);

CREATE TABLE paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_order_id TEXT NOT NULL UNIQUE,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,              -- 'buy' or 'sell'
  type TEXT NOT NULL,              -- 'limit', 'market', 'stop_loss_limit', 'limit_maker'
  price REAL,
  stop_price REAL,
  quantity REAL NOT NULL,
  filled REAL NOT NULL DEFAULT 0,
  avg_price REAL,
  status TEXT NOT NULL,            -- 'open', 'filled', 'canceled', 'rejected', 'expired'
  fee REAL NOT NULL DEFAULT 0,
  locked REAL NOT NULL DEFAULT 0,  -- balance reserved for what's left of this order
  list_client_id TEXT,             -- set for the two legs of an OCO
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_paper_orders_open ON paper_orders(status, pair);
CREATE INDEX idx_orders_state ON orders(state);
