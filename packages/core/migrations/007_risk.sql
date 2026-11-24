-- Phase 7: alerts the dashboard shows as toasts (and ntfy / Telegram can push).
-- dedupe_key is unique, so one event raises one alert however often it is checked (AL-01).
CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,               -- 'info', 'warn', 'critical'
  kind TEXT NOT NULL,                -- 'order_filled', 'stop_hit', 'target_hit', 'daily_loss_warning', 'daily_limit_hit', 'drawdown', 'health', 'kill_switch', ...
  message TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  order_id INTEGER,
  created_at TEXT NOT NULL,
  notified_at TEXT,                  -- when ntfy / Telegram delivery was attempted (null = not yet)
  notify_error TEXT                  -- why delivery failed, if it did (trading carries on regardless)
);
CREATE INDEX idx_alerts_pending ON alerts(notified_at) WHERE notified_at IS NULL;
