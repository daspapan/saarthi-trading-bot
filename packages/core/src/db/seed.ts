// Demo seed for paper mode: a clean account with exactly 10,000 USDT, so every
// video take starts from the same numbers. Running it again resets to the same state.

import { type Db, nowIso } from "./db.ts";

export const SEED_EQUITY_USDT = 10_000;

const RISK_FLAGS = ["kill_switch", "manual_restart", "daily_limit_hit", "feeds_paused", "exchange_unavailable"] as const;

// Trading tables cleared by a reset, children before parents (foreign keys).
// audit_log is NOT cleared: it is append-only by design. A reset is itself audited (phase 8).
const RESET_TABLES = [
  "paper_orders",
  "paper_balances",
  "order_events",
  "fills",
  "positions",
  "orders",
  "order_queue",
  "validator_results",
  "guardrail_results",
  "signals",
  "snapshots",
  "equity_snapshots",
  "risk_flags",
];

export function seedPaper(db: Db): void {
  const now = nowIso();
  db.exec("BEGIN");
  try {
    for (const t of RESET_TABLES) db.exec(`DELETE FROM ${t}`);
    db.prepare(
      `INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(SEED_EQUITY_USDT, SEED_EQUITY_USDT, SEED_EQUITY_USDT, SEED_EQUITY_USDT, now);
    // The simulated exchange starts with the same 10,000 USDT.
    db.prepare("INSERT INTO paper_balances (asset, free, locked) VALUES ('USDT', ?, 0)").run(SEED_EQUITY_USDT);
    const flag = db.prepare("INSERT INTO risk_flags (name, active, reason, updated_at) VALUES (?, ?, ?, ?)");
    for (const name of RISK_FLAGS) {
      // Fail closed: prices are not trusted until the feed process has checked them.
      if (name === "feeds_paused") flag.run(name, 1, "Waiting for both price feeds", now);
      else flag.run(name, 0, null, now);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function latestEquity(db: Db): number | null {
  const row = db.prepare("SELECT equity FROM equity_snapshots ORDER BY id DESC LIMIT 1").get() as
    | { equity: number }
    | undefined;
  return row ? row.equity : null;
}
