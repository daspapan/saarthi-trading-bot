-- 005_queue.sql: the validator's results and the order queue (phase 5).

-- What kind of order a queue item is, and why it left the queue without executing.
ALTER TABLE order_queue ADD COLUMN direction TEXT NOT NULL DEFAULT 'long';  -- 'long' (buy) or 'exit' (sell)
ALTER TABLE order_queue ADD COLUMN status_reason TEXT;                      -- e.g. 'Kill switch', 'Older than 15 minutes when picked up'
ALTER TABLE order_queue ADD COLUMN taken_at TEXT;                           -- when the executor claimed it

CREATE INDEX idx_validator_signal ON validator_results(signal_id);
CREATE INDEX idx_order_queue_signal ON order_queue(signal_id);
