// Daily loss, drawdown, exposure, alerts and notifications (RISK-01 to RISK-05, RISK-12, AL-01, AL-02, INT-08).

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  RiskMonitor,
  assessRisk,
  dayKey,
  getRiskFlag,
  listAlerts,
  loadSettingsFile,
  notifyConfigFrom,
  raiseAlert,
  readLiveState,
  readRiskView,
  riskViewLimits,
  sendPendingAlerts,
  setRiskFlag,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const RISK = loadSettingsFile(join(import.meta.dirname, "..", "..", "..", "config"), "risk.json");
const LIMITS = riskViewLimits(RISK); // 2% daily, warn at 80%, 15% drawdown
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const { db } = tempDb();
  const equity = (equity: number, o: { dayStart?: number; hwm?: number; at?: number } = {}) =>
    db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (?, ?, ?, ?, ?)").run(equity, equity, o.hwm ?? 10_000, o.dayStart ?? 10_000, iso(o.at ?? T0));
  const monitor = new RiskMonitor(db, () => RISK);
  const alerts = () => (db.prepare("SELECT kind, level, message FROM alerts ORDER BY id").all() as { kind: string; level: string; message: string }[]);
  return { db, equity, monitor, alerts };
}

describe("RISK-01 daily P&L includes realised, unrealised and fees", () => {
  it("RISK-01 daily P&L is equity now minus equity at the start of the UTC day", () => {
    const a = assessRisk({ equity: 9_870, dayStartEquity: 10_000, highWaterMark: 10_100 }, LIMITS);
    expect(a.dailyPnl).toBe(-130);
    expect(a.dailyPnlPct).toBeCloseTo(-1.3, 9);
    expect(a.dailyLossLimit).toBe(200);
    expect(a.dailyUsedPct).toBeCloseTo(65, 9);
    expect(a.drawdownPct).toBeCloseTo((230 / 10_100) * 100, 9);
  });

  it("RISK-01 the breakdown shows realised today, unrealised now and fees today, all from the database", () => {
    const { db, equity } = setup();
    equity(9_950);
    db.exec(`INSERT INTO price_state (pair, last, updated_at) VALUES ('BTC/USDT', 101000, '${iso(T0)}')`);
    db.exec(`INSERT INTO positions (pair, quantity, avg_entry, status, fees_paid, opened_at) VALUES ('BTC/USDT', 0.02, 100000, 'open', 2, '${iso(T0)}')`);
    db.exec(`INSERT INTO positions (pair, quantity, avg_entry, status, realised_pnl, fees_paid, opened_at, closed_at) VALUES ('ETH/USDT', 1, 3000, 'closed', -12.5, 6, '${iso(T0 - 3600_000)}', '${iso(T0 - 1800_000)}')`);
    db.exec(`INSERT INTO positions (pair, quantity, avg_entry, status, realised_pnl, fees_paid, opened_at, closed_at) VALUES ('SOL/USDT', 1, 200, 'closed', 99, 1, '${iso(T0 - 2 * 86_400_000)}', '${iso(T0 - 2 * 86_400_000)}')`);
    db.exec(`INSERT INTO orders (client_order_id, venue, pair, side, type, quantity, state, filled_quantity, entry_fee, exit_fee, created_at, updated_at, state_since) VALUES
      ('a', 'binance', 'ETH/USDT', 'buy', 'limit', 1, 'CLOSED', 1, 3, 3, '${iso(T0 - 3600_000)}', 'x', '${iso(T0 - 1800_000)}'),
      ('b', 'binance', 'BTC/USDT', 'buy', 'limit', 0.02, 'OPEN', 0.02, 2, NULL, '${iso(T0 - 600_000)}', 'x', '${iso(T0)}')`);
    const v = readRiskView(db, RISK, T0);
    expect(v.breakdown.realisedToday).toBe(-12.5); // yesterday's SOL trade is not today's
    expect(v.breakdown.unrealised).toBeCloseTo((101_000 - 100_000) * 0.02 - 2, 9);
    expect(v.breakdown.feesToday).toBe(8);
    expect(v.assessment!.dailyPnl).toBe(-50);
  });
});

describe("RISK-02 / RISK-03 / INT-08 daily loss limit", () => {
  it("RISK-02 a warning fires at 80% of the daily limit, once", () => {
    const { equity, monitor, alerts } = setup();
    equity(9_850); // -150 = 75%
    monitor.tick(T0);
    expect(alerts()).toEqual([]);
    equity(9_838); // -162 = 81%
    monitor.tick(T0 + 5_000);
    monitor.tick(T0 + 10_000);
    expect(alerts()).toEqual([{ kind: "daily_loss_warning", level: "warn", message: expect.stringMatching(/162\.00 USDT: 81% of the daily limit \(200\.00 USDT\)/) }]);
  });

  it("RISK-03 at 100% the flag is set, pending signals are discarded, and the validator refuses new orders", () => {
    const { db, equity, monitor, alerts } = setup();
    db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES ('BTC/USDT', 'long', '{}', 't', 'x')").run();
    db.prepare("INSERT INTO order_queue (dedupe_id, signal_id, pair, payload_json, status, created_at) VALUES ('d', 1, 'BTC/USDT', '{}', 'pending', ?)").run(iso(T0));
    equity(9_799);
    monitor.tick(T0);
    expect(getRiskFlag(db, "daily_limit_hit")).toEqual({ active: true, reason: expect.stringMatching(/^\[2026-01-05\] Lost 201\.00 USDT today/) });
    expect(db.prepare("SELECT status FROM order_queue").get()).toEqual({ status: "discarded" });
    expect(alerts().map((a) => a.kind)).toEqual(["daily_limit_hit"]); // the warning is skipped once the limit itself is hit
    monitor.tick(T0 + 5_000);
    expect(alerts()).toHaveLength(1);
    expect(readLiveState(db, T0).state.dailyLossLimitHit).toBe(true);
  });

  it("RISK-04 the daily limit resets at UTC midnight, with an alert", () => {
    const { db, equity, monitor, alerts } = setup();
    equity(9_700);
    monitor.tick(T0);
    expect(getRiskFlag(db, "daily_limit_hit").active).toBe(true);
    const midnight = Date.UTC(2026, 0, 6, 0, 0, 1);
    equity(9_700, { dayStart: 9_700, at: midnight }); // the executor starts the new day from the current equity
    monitor.tick(midnight);
    expect(getRiskFlag(db, "daily_limit_hit").active).toBe(false);
    expect(alerts().at(-1)).toMatchObject({ kind: "daily_limit_reset" });
    expect(dayKey(midnight)).toBe("2026-01-06");
  });

  it("RISK-04 just before midnight it is still on", () => {
    const { db, equity, monitor } = setup();
    equity(9_700);
    monitor.tick(T0);
    monitor.tick(Date.UTC(2026, 0, 5, 23, 59, 59));
    expect(getRiskFlag(db, "daily_limit_hit").active).toBe(true);
  });

  it("RISK-03 an equity figure from yesterday never triggers today's limit", () => {
    const { db, equity, monitor } = setup();
    equity(9_000, { at: T0 - 86_400_000 });
    monitor.tick(T0);
    expect(getRiskFlag(db, "daily_limit_hit").active).toBe(false);
  });
});

describe("RISK-05 drawdown is measured from the high-water mark", () => {
  it.each([
    [10_000, 10_000, 0],
    [9_000, 10_000, 10],
    [11_000, 12_000, 8.333],
    [12_500, 12_000, 0], // above the mark: no drawdown
  ])("RISK-05 equity %d with a high of %d is %d%% down", (equity, hwm, pct) => {
    const a = assessRisk({ equity, dayStartEquity: equity, highWaterMark: hwm }, LIMITS);
    expect(a.drawdownPct).toBeCloseTo(pct, 2);
    expect(a.drawdownHit).toBe(false);
  });

  it("RISK-05 exactly at the limit counts as hit", () => {
    expect(assessRisk({ equity: 8_500, dayStartEquity: 8_500, highWaterMark: 10_000 }, LIMITS).drawdownHit).toBe(true);
    expect(assessRisk({ equity: 8_501, dayStartEquity: 8_501, highWaterMark: 10_000 }, LIMITS).drawdownHit).toBe(false);
  });
});

describe("RISK-12 exposure and concentration", () => {
  it("RISK-12 exposure is the market value of all positions, per pair and in total, as % of equity", () => {
    const { db, equity } = setup();
    equity(10_000);
    db.exec(`INSERT INTO price_state (pair, last, updated_at) VALUES ('BTC/USDT', 100000, 'x'), ('ETH/USDT', 3000, 'x')`);
    db.exec(`INSERT INTO positions (pair, quantity, avg_entry, status, opened_at) VALUES ('BTC/USDT', 0.02, 95000, 'open', 'x'), ('ETH/USDT', 1, 2900, 'open', 'x'), ('SOL/USDT', 5, 200, 'open', 'x')`);
    const v = readRiskView(db, RISK, T0);
    expect(v.exposure.byPair).toEqual([
      { pair: "BTC/USDT", value: 2_000, pct: 20, limitPct: LIMITS.maxAssetBps / 100 },
      { pair: "ETH/USDT", value: 3_000, pct: 30, limitPct: LIMITS.maxAssetBps / 100 },
      { pair: "SOL/USDT", value: 1_000, pct: 10, limitPct: LIMITS.maxAssetBps / 100 }, // no price yet: valued at entry
    ]);
    expect(v.exposure.total).toBe(6_000);
    expect(v.exposure.pct).toBe(60);
    expect(v.exposure.limitPct).toBe(LIMITS.maxExposureBps / 100);
  });

  it("RISK-12 with no equity figure yet everything reads as zero, not an error", () => {
    const { db } = setup();
    const v = readRiskView(db, RISK, T0);
    expect(v.assessment).toBeNull();
    expect(v.exposure).toMatchObject({ total: 0, pct: 0 });
  });
});

describe("Health alarm", () => {
  it("AL-01 the executor going quiet raises one alarm per outage (critical while it holds positions)", () => {
    const { db, monitor, alerts } = setup();
    const beat = (name: string, _d: string, at: number) =>
      db.prepare("INSERT INTO process_heartbeats (name, pid, started_at, last_beat_at) VALUES (?, 1, ?, ?) ON CONFLICT(name) DO UPDATE SET last_beat_at = excluded.last_beat_at").run(name, iso(at), iso(at));
    beat("executor", "ok", T0 - 60_000);
    beat("feed", "ok", T0);
    db.exec(`INSERT INTO orders (client_order_id, venue, pair, side, type, quantity, state, created_at, updated_at) VALUES ('x', 'binance', 'BTC/USDT', 'buy', 'limit', 1, 'OPEN', 'x', 'x')`);
    monitor.tick(T0);
    monitor.tick(T0 + 5_000);
    expect(alerts()).toEqual([{ kind: "health", level: "critical", message: expect.stringMatching(/executor process stopped reporting 60 s ago\. Open positions still have their stops/) }]);
    beat("executor", "ok", T0 + 10_000); // back up
    beat("feed", "ok", T0 + 90_000);
    monitor.tick(T0 + 10_000);
    monitor.tick(T0 + 90_000); // down again: a new outage, a new alarm
    expect(alerts()).toHaveLength(2);
  });
});

describe("AL-01 each alert fires once per event", () => {
  it("AL-01 the same key twice gives one alert and one audit row", () => {
    const { db } = setup();
    expect(raiseAlert(db, { level: "info", kind: "order_filled", message: "m", key: "order_filled:1" })).toBe(true);
    expect(raiseAlert(db, { level: "info", kind: "order_filled", message: "m", key: "order_filled:1" })).toBe(false);
    expect(raiseAlert(db, { level: "info", kind: "order_filled", message: "m", key: "order_filled:2" })).toBe(true);
    const ids = listAlerts(db).map((a) => a.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeGreaterThan(ids[1]!); // newest first
    expect(listAlerts(db, { afterId: ids[1] }).map((a) => a.id)).toEqual([ids[0]]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'alert'").get()).toEqual({ n: 2 });
  });
});

describe("AL-02 a notification failure never stops anything", () => {
  it("AL-02 ntfy down and Telegram returning 500: logged and stored on the alert, nothing thrown", async () => {
    const { db } = setup();
    raiseAlert(db, { level: "critical", kind: "kill_switch", message: "Kill switch pressed", key: "k1" });
    const warnings: object[] = [];
    const calls: string[] = [];
    const r = await sendPendingAlerts(db, { ntfyUrl: "https://ntfy.sh/topic", telegram: { botToken: "SECRET-TOKEN", chatId: "1" } }, {
      fetch: async (url) => {
        calls.push(url.includes("telegram") ? "telegram" : "ntfy");
        if (!url.includes("telegram")) throw new Error("getaddrinfo ENOTFOUND ntfy.sh");
        return { ok: false, status: 500 };
      },
      log: { warn: (o) => warnings.push(o) },
    });
    expect(r).toEqual({ sent: 0, failed: 1 });
    expect(calls).toEqual(["ntfy", "telegram"]);
    const row = db.prepare("SELECT notified_at, notify_error FROM alerts").get() as { notified_at: string; notify_error: string };
    expect(row.notified_at).not.toBeNull();
    expect(row.notify_error).toBe("ntfy: getaddrinfo ENOTFOUND ntfy.sh; telegram: HTTP 500");
    expect(JSON.stringify(warnings)).not.toContain("SECRET-TOKEN");
    // Attempted once: the next pass doesn't retry or throw.
    expect(await sendPendingAlerts(db, { ntfyUrl: "https://ntfy.sh/topic", telegram: null }, { fetch: async () => { throw new Error("x"); } })).toEqual({ sent: 0, failed: 0 });
  });

  it("AL-02 ntfy gets the message with a title and priority; nothing configured means toasts only", async () => {
    const { db } = setup();
    raiseAlert(db, { level: "warn", kind: "stop_hit", message: "BTC/USDT stop hit", key: "s1" });
    let sent: { url: string; headers: Record<string, string>; body: string } | null = null;
    await sendPendingAlerts(db, notifyConfigFrom({ NTFY_URL: "https://ntfy.sh/t" }), { fetch: async (url, init) => { sent = { url, headers: init.headers, body: init.body }; return { ok: true, status: 200 }; } });
    expect(sent).toEqual({ url: "https://ntfy.sh/t", headers: { Title: "Saarthi: stop hit", Priority: "high", Tags: "warn" }, body: "BTC/USDT stop hit" });
    raiseAlert(db, { level: "info", kind: "x", message: "m", key: "s2" });
    expect(await sendPendingAlerts(db, notifyConfigFrom({}), { fetch: async () => { throw new Error("must not be called"); } })).toEqual({ sent: 0, failed: 0 });
  });

  it("AL-02 a failing risk check would not block notifications, and vice versa: the kill switch is pure database work", async () => {
    const { db } = setup();
    // The kill switch path never calls fetch at all (see killSwitch.ts); sending is a separate loop.
    const { triggerLiquidation } = await import("../src/index.ts");
    const r = triggerLiquidation(db, { source: "kill-switch", reason: "t", actor: "operator" });
    expect(r.alreadyActive).toBe(false);
    await sendPendingAlerts(db, { ntfyUrl: "https://ntfy.sh/t", telegram: null }, { fetch: async () => { throw new Error("offline"); } });
    expect(getRiskFlag(db, "liquidate").active).toBe(true);
  });
});
