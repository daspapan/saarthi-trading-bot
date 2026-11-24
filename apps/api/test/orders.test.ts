// GET /orders, /positions, /trades: what the Orders page shows, after fees.

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { type Candidate, Executor, PaperExchange, enqueue, loadBaseEnv, loadSettingsFile, seedPaper, writeEvaluation, writePriceState } from "@saarthi/core";
import { tempDb, validEnv } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/app.ts";

const RISK = loadSettingsFile(join(import.meta.dirname, "..", "..", "..", "config"), "risk.json");
const feed = { status: "ok", lastDataMs: 0, stalePairs: [], detail: "" };
const trusted = { feeds: { A: feed, B: feed }, pairs: [], problems: [], paused: false, reason: null, agreeSinceMs: null, resumeInMs: null, change: null };

async function scenario() {
  const { db } = tempDb();
  seedPaper(db);
  let now = Date.UTC(2026, 0, 5, 12);
  let price = 100_050;
  const paper = new PaperExchange(db, { price: () => price, now: () => now });
  const ex = new Executor({ db, client: paper, risk: () => RISK, now: () => now });
  const c: Candidate = { id: "m-1", strategy: "momentum", pair: "BTC/USDT", direction: "long", entry: 100_000, stop: 99_400, target: 101_200, rewardToRisk: 2, stopAtr: 1.5, atr: 400, quantity: 0.025, notional: 2500, riskAmount: 15, score: 0.5, reason: "r", dataPoints: [] };
  db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES ('BTC/USDT', 'long', '{}', 't', 'x')").run();
  enqueue(db, { signalId: 1, snapshotHash: "a".repeat(64), pair: "BTC/USDT", direction: "long", candidateId: "m-1", confidence: "medium", candidate: c }, { nowMs: now });
  const step = async (p: number, n = 1) => {
    for (let i = 0; i < n; i++) {
      price = p;
      now += 1000;
      writePriceState(db, { pair: "BTC/USDT", bid: null, ask: null, last: p, change24hPct: null, volume24h: null, timeMs: now }, null, null, now);
      writeEvaluation(db, trusted as never, 60, now);
      paper.process();
      await ex.tick();
    }
  };
  const app = createApp(db, loadBaseEnv(validEnv()), { analystToken: "t".repeat(64) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = async (path: string) => (await fetch(url + path)).json() as Promise<any>;
  return { step, get, close: () => server.close() };
}

describe("API orders, positions and trades", () => {
  it("UI-13 /orders lists every state change, and /positions shows live P&L after fees and stop-to-target progress", async () => {
    const s = await scenario();
    await s.step(100_050, 3);
    await s.step(99_990, 2);
    await s.step(100_900);
    const { states, orders } = await s.get("/orders");
    expect(states).toContain("PLACE_PROTECTION");
    expect(orders[0]).toMatchObject({ id: 1, pair: "BTC/USDT", state: "OPEN", filled: 0.025, stopPrice: 99_400, targetPrice: 101_200 });
    expect(orders[0].events.map((e: { to: string }) => e.to)).toEqual(["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "OPEN"]);

    const { positions } = await s.get("/positions");
    const p = positions[0];
    const entry = 100_000 * 1.0005;
    const expected = (100_900 - entry) * 0.025 - entry * 0.025 * 0.001 - 100_900 * 0.025 * 0.001;
    expect(p.unrealisedPnl).toBeCloseTo(expected, 6);
    expect(p.progress).toBeCloseTo((100_900 - 99_400) / (101_200 - 99_400), 9);
    expect(p.lastPrice).toBe(100_900);
    s.close();
  });

  it("EX-14 / UI-13 /trades shows the closed trade with both fees and P&L after fees, and totals", async () => {
    const s = await scenario();
    await s.step(100_050, 3);
    await s.step(99_990, 2);
    await s.step(101_300, 2);
    const { trades, totals } = await s.get("/trades");
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t).toMatchObject({ orderId: 1, pair: "BTC/USDT", closeReason: "target", quantity: 0.025 });
    expect(t.entryFee).toBeGreaterThan(0);
    expect(t.exitFee).toBeGreaterThan(0);
    expect(t.realisedPnl).toBeCloseTo((t.exitPrice - t.entryPrice) * 0.025 - t.entryFee - t.exitFee, 9);
    expect(totals).toMatchObject({ count: 1, wins: 1 });
    expect(totals.fees).toBeCloseTo(t.entryFee + t.exitFee, 9);
    expect((await s.get("/positions")).positions).toEqual([]);
    s.close();
  });

  it("API-01 an empty database gives empty lists, not errors", async () => {
    const s = await scenario();
    expect((await s.get("/trades")).totals).toEqual({ count: 0, wins: 0, realisedPnl: 0, fees: 0 });
    expect((await s.get("/positions")).positions).toEqual([]);
    expect((await s.get("/orders?limit=abc")).orders).toEqual([]);
    s.close();
  });
});
