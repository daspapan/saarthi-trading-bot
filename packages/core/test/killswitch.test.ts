// Kill switch, drawdown stop and liquidation (RISK-06 to RISK-11, INT-06, INT-09).

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  type Candidate,
  Executor,
  PaperExchange,
  RiskMonitor,
  enqueue,
  getOrderRow,
  getRiskFlag,
  hashPin,
  listQueue,
  loadSettingsFile,
  restartTrading,
  seedPaper,
  setRiskFlag,
  triggerLiquidation,
  writeEvaluation,
  writePriceState,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const RISK = loadSettingsFile(join(import.meta.dirname, "..", "..", "..", "config"), "risk.json");
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const feed = { status: "ok", lastDataMs: 0, stalePairs: [], detail: "" };
const trusted = { feeds: { A: feed, B: feed }, pairs: [], problems: [], paused: false, reason: null, agreeSinceMs: null, resumeInMs: null, change: null };
const PIN_HASH = hashPin("2468");

const SETUPS: Record<string, { entry: number; stop: number; target: number; qty: number }> = {
  "BTC/USDT": { entry: 100_000, stop: 99_400, target: 101_200, qty: 0.02 },
  "ETH/USDT": { entry: 3_000, stop: 2_970, target: 3_060, qty: 0.6 },
  "SOL/USDT": { entry: 200, stop: 198, target: 204, qty: 9 },
};

function world() {
  const { db } = tempDb();
  seedPaper(db);
  const clock = { now: T0 };
  const prices: Record<string, number> = { "BTC/USDT": 100_050, "ETH/USDT": 3_001.5, "SOL/USDT": 200.1 };
  const paper = new PaperExchange(db, { price: (p) => prices[p] ?? null, now: () => clock.now });
  const executor = new Executor({ db, client: paper, risk: () => RISK, now: () => clock.now });
  let n = 0;
  const writePrices = (feedsAlive = true) => {
    if (!feedsAlive) return; // RISK-10: the feed process is stopped, prices stay as they were
    for (const [pair, last] of Object.entries(prices)) {
      writePriceState(db, { pair, bid: null, ask: null, last, change24hPct: null, volume24h: null, timeMs: clock.now }, null, null, clock.now);
    }
    writeEvaluation(db, trusted as never, 60, clock.now);
  };
  writePrices();
  const queue = (pair: string) => {
    const s = SETUPS[pair]!;
    n += 1;
    const c: Candidate = { id: `m-${pair}-${n}`, strategy: "momentum", pair, direction: "long", entry: s.entry, stop: s.stop, target: s.target, rewardToRisk: 2, stopAtr: 1.5, atr: 1, quantity: s.qty, notional: s.entry * s.qty, riskAmount: (s.entry - s.stop) * s.qty, score: 0.5, reason: "r", dataPoints: [] };
    db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES (?, 'long', '{}', 't', 'x')").run(pair);
    enqueue(db, { signalId: n, snapshotHash: "a".repeat(64), pair, direction: "long", candidateId: c.id, confidence: "medium", candidate: c }, { nowMs: clock.now });
  };
  const tick = async (k = 1, feedsAlive = true) => {
    for (let i = 0; i < k; i++) {
      clock.now += 1_000;
      writePrices(feedsAlive);
      paper.process();
      await executor.tick();
    }
  };
  /** Three positions open and protected: BTC, ETH, SOL. */
  const openThree = async () => {
    for (const p of Object.keys(SETUPS)) queue(p);
    await tick(3);
    for (const p of Object.keys(SETUPS)) prices[p] = SETUPS[p]!.entry * 0.9999;
    await tick(3);
    for (const p of Object.keys(SETUPS)) prices[p] = SETUPS[p]!.entry * 1.002;
    await tick(1);
  };
  const states = () => (db.prepare("SELECT state FROM orders ORDER BY id").all() as { state: string }[]).map((r) => r.state);
  const alerts = () => db.prepare("SELECT level, kind, message FROM alerts ORDER BY id").all() as { level: string; kind: string; message: string }[];
  const bal = async () => paper.balances();
  return { db, clock, prices, paper, executor, queue, tick, openThree, states, alerts, bal };
}

describe("RISK-06 / RISK-09 / INT-06 the kill switch closes everything within 30 seconds", () => {
  it("INT-06 three open positions plus a resting entry: all cancelled or sold, coins gone, within 30 s", async () => {
    const w = world();
    await w.openThree();
    expect(w.states()).toEqual(["OPEN", "OPEN", "OPEN"]);

    const pressedAt = w.clock.now;
    const r = triggerLiquidation(w.db, { source: "kill-switch", reason: "test", actor: "operator" }, w.clock.now);
    expect(r.alreadyActive).toBe(false);
    let seconds = 0;
    while (getRiskFlag(w.db, "liquidate").active && seconds < 30) {
      await w.tick();
      seconds += 1;
    }
    expect(seconds).toBeLessThanOrEqual(30);
    expect(getRiskFlag(w.db, "liquidate").active).toBe(false);
    expect(w.states().every((s) => s === "CLOSED" || s === "CANCELLED")).toBe(true);
    const closed = w.db.prepare("SELECT close_reason FROM orders WHERE state = 'CLOSED'").all() as { close_reason: string }[];
    expect(closed.map((c) => c.close_reason)).toEqual(["kill-switch", "kill-switch", "kill-switch"]);
    const b = await w.bal();
    for (const coin of ["BTC", "ETH", "SOL"]) expect(b[coin]?.free ?? 0).toBeLessThan(1e-9);
    for (const coin of ["BTC", "ETH", "SOL", "USDT"]) expect(b[coin]?.locked ?? 0).toBeLessThan(1e-9);
    expect(await w.paper.openOrders()).toEqual([]);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE status = 'open'").get()).toEqual({ n: 0 });
    // Still stopped: needs a PIN restart.
    expect(getRiskFlag(w.db, "kill_switch").active).toBe(true);
    expect(getRiskFlag(w.db, "manual_restart").active).toBe(true);
    const done = w.alerts().find((a) => a.kind === "kill_switch_done")!;
    expect(done.message).toMatch(/every order is cancelled and every position sold/);
    expect(w.clock.now - pressedAt).toBeLessThanOrEqual(30_000);
  });

  it("RISK-06 a resting entry and a queued signal are cancelled, nothing new is placed", async () => {
    const w = world();
    w.queue("ETH/USDT");
    await w.tick(3); // resting limit
    w.queue("SOL/USDT"); // still pending in the queue
    triggerLiquidation(w.db, { source: "kill-switch", reason: "test", actor: "operator" }, w.clock.now);
    await w.tick(3);
    expect(w.states()).toEqual(["CANCELLED"]);
    expect(listQueue(w.db).map((q) => q.status).sort()).toEqual(["discarded", "taken"]);
    expect(await w.paper.openOrders()).toEqual([]);
    expect((await w.bal()).USDT).toEqual({ free: 10_000, locked: 0 });
  });

  it("RISK-06 an entry that partly filled before the cancel is sold, not left behind", async () => {
    const w = world();
    w.queue("BTC/USDT");
    await w.tick(3);
    w.paper.partialFillNext(0.5);
    w.prices["BTC/USDT"] = 99_990;
    await w.tick(1); // half filled, order still resting
    w.prices["BTC/USDT"] = 100_100;
    triggerLiquidation(w.db, { source: "kill-switch", reason: "test", actor: "operator" }, w.clock.now);
    await w.tick(3);
    expect(getOrderRow(w.db, 1)).toMatchObject({ state: "CLOSED", close_reason: "kill-switch" });
    expect((await w.bal()).BTC?.free ?? 0).toBeLessThan(1e-9);
  });
});

describe("RISK-10 the kill switch works with Ollama, the analyst, the feed and the web app stopped", () => {
  it("RISK-10 only the database and the executor are needed: no API call, no fresh prices", async () => {
    const w = world();
    await w.openThree();
    // The feed stops: prices freeze, trust lapses. Pressing writes straight to the DB (what `npm run kill` does).
    triggerLiquidation(w.db, { source: "kill-switch", reason: "terminal", actor: "operator-cli" }, w.clock.now);
    for (let s = 0; s < 30 && getRiskFlag(w.db, "liquidate").active; s++) await w.tick(1, false);
    expect(getRiskFlag(w.db, "liquidate").active).toBe(false);
    expect(w.states()).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
  });

  it("RISK-10 if the executor itself was down, it closes everything as soon as it is back", async () => {
    const w = world();
    await w.openThree();
    triggerLiquidation(w.db, { source: "kill-switch", reason: "test", actor: "operator-cli" }, w.clock.now);
    const fresh = new Executor({ db: w.db, client: w.paper, risk: () => RISK, now: () => w.clock.now });
    for (let s = 0; s < 10 && getRiskFlag(w.db, "liquidate").active; s++) {
      w.clock.now += 1000;
      await fresh.tick();
    }
    expect(w.states()).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
  });
});

describe("RISK-11 pressing the kill switch twice is safe", () => {
  it("RISK-11 a second press while closing changes nothing; one alert, one sale per position", async () => {
    const w = world();
    await w.openThree();
    expect(triggerLiquidation(w.db, { source: "kill-switch", reason: "first", actor: "operator" }, w.clock.now).alreadyActive).toBe(false);
    await w.tick(1);
    expect(triggerLiquidation(w.db, { source: "kill-switch", reason: "second", actor: "operator" }, w.clock.now).alreadyActive).toBe(true);
    for (let s = 0; s < 30 && getRiskFlag(w.db, "liquidate").active; s++) await w.tick();
    expect(w.alerts().filter((a) => a.kind === "kill_switch")).toHaveLength(1);
    const sells = w.db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE type = 'market' AND side = 'sell'").get() as { n: number };
    expect(sells.n).toBe(3);
    expect(getRiskFlag(w.db, "kill_switch").reason).toBe("first");
    // And after everything is closed, pressing again is harmless too.
    triggerLiquidation(w.db, { source: "kill-switch", reason: "third", actor: "operator" }, w.clock.now);
    await w.tick(2);
    expect(getRiskFlag(w.db, "liquidate").active).toBe(false);
    expect(w.states()).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
  });

  it("AUD-01 every press is audited, including the repeat", async () => {
    const w = world();
    triggerLiquidation(w.db, { source: "kill-switch", reason: "a", actor: "operator" }, w.clock.now);
    triggerLiquidation(w.db, { source: "kill-switch", reason: "b", actor: "operator" }, w.clock.now);
    const rows = (w.db.prepare("SELECT payload_json FROM audit_log WHERE event_type = 'kill_switch'").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json));
    expect(rows.map((r) => r.alreadyActive)).toEqual([false, true]);
  });
});

describe("RISK-07 restart from manual-restart needs the correct PIN", () => {
  async function stopped() {
    const w = world();
    await w.openThree();
    triggerLiquidation(w.db, { source: "kill-switch", reason: "test", actor: "operator" }, w.clock.now);
    return w;
  }

  it("RISK-07 refused while positions are still being closed", async () => {
    const w = await stopped();
    expect(restartTrading(w.db, "2468", PIN_HASH, "operator", w.clock.now)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/Still closing/) });
  });

  it("RISK-07 a wrong PIN is refused and audited; the right PIN restarts trading", async () => {
    const w = await stopped();
    for (let s = 0; s < 30 && getRiskFlag(w.db, "liquidate").active; s++) await w.tick();
    expect(restartTrading(w.db, "1111", PIN_HASH, "operator", w.clock.now)).toMatchObject({ ok: false, status: 403 });
    expect(restartTrading(w.db, undefined, PIN_HASH, "operator", w.clock.now)).toMatchObject({ ok: false, status: 403 });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'pin_rejected'").get()).toEqual({ n: 2 });
    expect(getRiskFlag(w.db, "kill_switch").active).toBe(true);
    expect(restartTrading(w.db, "2468", PIN_HASH, "operator", w.clock.now)).toEqual({ ok: true });
    expect(getRiskFlag(w.db, "kill_switch").active).toBe(false);
    expect(getRiskFlag(w.db, "manual_restart").active).toBe(false);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'restart'").get()).toEqual({ n: 1 });
  });

  it("RISK-07 without a PIN configured, restart explains how to set one", async () => {
    const w = await stopped();
    expect(restartTrading(w.db, "2468", null, "operator")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/PIN_HASH/) });
  });

  it("RISK-07 nothing to restart when trading isn't stopped", () => {
    const w = world();
    expect(restartTrading(w.db, "2468", PIN_HASH, "operator")).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/not stopped/) });
  });

  it("RISK-07 a restart does not clear the daily loss flag (that waits for UTC midnight)", async () => {
    const w = await stopped();
    for (let s = 0; s < 30 && getRiskFlag(w.db, "liquidate").active; s++) await w.tick();
    setRiskFlag(w.db, "daily_limit_hit", true, "[2026-01-05] x");
    restartTrading(w.db, "2468", PIN_HASH, "operator");
    expect(getRiskFlag(w.db, "daily_limit_hit").active).toBe(true);
  });
});

describe("INT-09 drawdown limit: everything closed, manual restart with PIN", () => {
  it("INT-09 equity 15% below its high: the risk monitor triggers the same liquidation as the kill switch", async () => {
    const w = world();
    await w.openThree();
    w.db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (?, ?, ?, ?, ?)").run(8_490, 3_000, 10_000, 8_600, new Date(w.clock.now).toISOString());
    new RiskMonitor(w.db, () => RISK).tick(w.clock.now);
    expect(getRiskFlag(w.db, "liquidate")).toEqual({ active: true, reason: "drawdown" });
    expect(getRiskFlag(w.db, "manual_restart").reason).toMatch(/15\.1% below its high of 10000\.00 \(limit 15%\)/);
    for (let s = 0; s < 30 && getRiskFlag(w.db, "liquidate").active; s++) await w.tick();
    const reasons = (w.db.prepare("SELECT close_reason FROM orders").all() as { close_reason: string }[]).map((r) => r.close_reason);
    expect(reasons).toEqual(["drawdown", "drawdown", "drawdown"]);
    expect(w.alerts().filter((a) => a.kind === "drawdown")).toHaveLength(1);
    // The monitor keeps running: no second liquidation while manual restart is pending.
    new RiskMonitor(w.db, () => RISK).tick(w.clock.now + 5_000);
    expect(getRiskFlag(w.db, "liquidate").active).toBe(false);
    expect(restartTrading(w.db, "2468", PIN_HASH, "operator")).toEqual({ ok: true });
  });
});
