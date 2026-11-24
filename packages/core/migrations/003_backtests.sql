-- 003_backtests.sql: what the Backtest Lab needs on top of 001.

-- Runs happen in a background thread, so a run has a status while it works.
ALTER TABLE backtest_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'done'; -- 'running', 'done', 'failed'
ALTER TABLE backtest_runs ADD COLUMN error TEXT;                          -- plain-language reason if it failed
ALTER TABLE backtest_runs ADD COLUMN label TEXT;                          -- a name you give the run, for comparing
-- Benchmark, drawdown curve, walk-forward split, risk events and rejection counts (JSON).
ALTER TABLE backtest_runs ADD COLUMN result_json TEXT;

-- Extra detail per backtest trade.
ALTER TABLE backtest_trades ADD COLUMN strategy TEXT;
ALTER TABLE backtest_trades ADD COLUMN candidate_id TEXT;
ALTER TABLE backtest_trades ADD COLUMN slippage REAL;

CREATE INDEX idx_backtest_trades_run ON backtest_trades(run_id, entry_time_ms);
