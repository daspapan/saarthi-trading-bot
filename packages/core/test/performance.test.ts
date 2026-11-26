// The Performance page's numbers: curve, drawdown, daily P&L, returns vs holding BTC.

import { describe, expect, it } from "vitest";
import { readPerformance } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 2, 31, 12);
const iso = (ms: number) => new Date(ms).toISOString();

function setup() {
  const { db } = tempDb();
  const snap = (ms: number, equity: number, hwm: number, dayStart: number) =>
    db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (?, ?, ?, ?, ?)").run(equity, equity, hwm, dayStart, iso(ms));
  const btc = (ms: number, close: number) =>
    db.prepare("INSERT INTO candles (source, pair, timeframe, open_time_ms, open, high, low, close, volume) VALUES ('binance-testnet', 'BTC/USDT', '4h', ?, ?, ?, ?, ?, 1)").run(ms, close, close, close, close);
  return { db, snap, btc };
}

describe("Performance", () => {
  it("UI-08 returns over 30/60/90 days next to buy-and-hold BTC, daily P&L, max drawdown", () => {
    const { db, snap, btc } = setup();
    // 100 days of history: equity 10,000 -> 10,600, with a dip to 9,500 (5% below a 10,000 high).
    for (let d = 100; d >= 0; d--) {
      const t = NOW - d * DAY;
      const eq = d === 50 ? 9_500 : 10_000 + (100 - d) * 6;
      const hwm = d === 50 ? 10_300 : Math.max(10_000, eq);
      snap(t, eq, hwm, eq - 10);
      btc(t - 3_600_000, 60_000 + (100 - d) * 100);
    }
    const p = readPerformance(db, NOW);
    expect(p.summary).toMatchObject({ startEquity: 10_000, equity: 10_600, trades: 0 });
    expect(p.summary.totalReturnPct).toBeCloseTo(6, 9);
    expect(p.summary.maxDrawdownPct).toBeCloseTo(((10_300 - 9_500) / 10_300) * 100, 6);
    const w30 = p.windows.find((w) => w.days === 30)!;
    expect(w30.actualDays).toBe(30);
    expect(w30.returnPct).toBeCloseTo(((10_600 - 10_420) / 10_420) * 100, 6);
    expect(w30.btcPct).toBeCloseTo(((70_000 - 67_000) / 67_000) * 100, 6);
    expect(p.daily.at(-1)).toEqual({ day: "2026-03-31", pnl: 10, pnlPct: (10 / 10_590) * 100 });
    expect(p.curve.length).toBeGreaterThan(80); // one point per hour bucket, here one per day
  });

  it("UI-08 a history shorter than the window says how many days it really covers", () => {
    const { db, snap } = setup();
    snap(NOW - 5 * DAY, 10_000, 10_000, 10_000);
    snap(NOW, 10_200, 10_200, 10_150);
    const w90 = readPerformance(db, NOW).windows.find((w) => w.days === 90)!;
    expect(w90).toMatchObject({ actualDays: 5, btcPct: null });
    expect(w90.returnPct).toBeCloseTo(2, 9);
  });

  it("UI-08 no equity yet: empty, not an error", () => {
    const { db } = setup();
    const p = readPerformance(db, NOW);
    expect(p).toMatchObject({ curve: [], daily: [], summary: { equity: null, totalReturnPct: null, maxDrawdownPct: 0 } });
    expect(p.windows.every((w) => w.returnPct === null)).toBe(true);
  });

  it("UI-08 closed trades: count, wins, fees and P&L after fees", () => {
    const { db } = setup();
    db.exec(`INSERT INTO orders (client_order_id, venue, pair, side, type, quantity, state, direction, realised_pnl, entry_fee, exit_fee, created_at, updated_at) VALUES
      ('a','binance','BTC/USDT','buy','limit',1,'CLOSED','long',12.5,1,1,'x','x'),
      ('b','binance','BTC/USDT','buy','limit',1,'CLOSED','long',-4,1,0.9,'x','x'),
      ('c','binance','BTC/USDT','sell','market',1,'CLOSED','exit',12.5,0,1,'x','x')`);
    expect(readPerformance(db, NOW).summary).toMatchObject({ trades: 2, wins: 1, realisedPnl: 8.5, fees: 3.9 });
  });
});
