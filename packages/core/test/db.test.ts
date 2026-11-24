import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEED_EQUITY_USDT, latestEquity, listTables, migrate, openDb, seedPaper } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const SPEC_TABLES = [
  "candles", "price_state", "feed_health", "snapshots", "signals", "guardrail_results",
  "validator_results", "order_queue", "orders", "order_events", "fills", "positions",
  "equity_snapshots", "risk_flags", "settings_history", "backtest_runs", "backtest_trades", "audit_log",
  "feed_monitor", "exchange_health",
];

describe("DB-01 migrations", () => {
  it("DB-01 run cleanly on an empty database and create every table from the spec", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "saarthi-")), "empty.db"));
    expect(listTables(db)).toEqual([]);
    expect(migrate(db)).toEqual(["001_init.sql", "002_feeds.sql", "003_backtests.sql", "004_analyst.sql", "005_queue.sql", "006_executor.sql", "007_risk.sql"]);
    const tables = listTables(db);
    for (const t of SPEC_TABLES) expect(tables).toContain(t);
  });

  it("DB-01 are safe to run twice", () => {
    const { db } = tempDb();
    const before = listTables(db);
    expect(migrate(db)).toEqual([]);
    expect(migrate(db)).toEqual([]);
    expect(listTables(db)).toEqual(before);
  });

  it("DB-01 the audit table already refuses UPDATE and DELETE at the database level", () => {
    const { db } = tempDb();
    db.prepare(
      "INSERT INTO audit_log (event_type, actor, payload_json, created_at, prev_hash, hash) VALUES ('t','test','{}','now','0','h')",
    ).run();
    expect(() => db.exec("UPDATE audit_log SET actor = 'x'")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log")).toThrow(/append-only/);
  });
});

describe("DB-02 seed", () => {
  it("DB-02 gives a predictable 10,000 USDT starting equity, every time", () => {
    const { db } = tempDb();
    seedPaper(db);
    expect(latestEquity(db)).toBe(10_000);
    expect(SEED_EQUITY_USDT).toBe(10_000);

    // Dirty the account, then reseed: back to exactly the same state.
    db.prepare(
      "INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (8123.45, 8000, 10000, 10000, 'x')",
    ).run();
    seedPaper(db);
    expect(latestEquity(db)).toBe(10_000);
    expect((db.prepare("SELECT COUNT(*) AS n FROM equity_snapshots").get() as { n: number }).n).toBe(1);
    const flags = db.prepare("SELECT name, active FROM risk_flags ORDER BY name").all();
    expect(flags).toEqual([
      { name: "daily_limit_hit", active: 0 },
      { name: "exchange_unavailable", active: 0 },
      { name: "feeds_paused", active: 1 },
      { name: "kill_switch", active: 0 },
      { name: "manual_restart", active: 0 },
    ]);
  });
});
