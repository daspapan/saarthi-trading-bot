-- 004_analyst.sql: what the AI analyst (phase 4) needs on top of 001.

-- Which analysis run a signal came from, why a system signal was made, and model details.
ALTER TABLE signals ADD COLUMN run_id TEXT;
ALTER TABLE signals ADD COLUMN note TEXT;        -- e.g. "AI unavailable: ..." or "skipped: data not trusted (...)"
ALTER TABLE signals ADD COLUMN model TEXT;
ALTER TABLE signals ADD COLUMN latency_ms INTEGER;
ALTER TABLE signals ADD COLUMN trigger TEXT;     -- 'schedule' or 'manual'

-- "Analyse now" button presses. The analyst process polls this (read-only)
-- and runs once for each new row; it never writes here itself.
CREATE TABLE analysis_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requested_at TEXT NOT NULL
);

CREATE INDEX idx_signals_run ON signals(run_id);
CREATE INDEX idx_guardrail_signal ON guardrail_results(signal_id);
