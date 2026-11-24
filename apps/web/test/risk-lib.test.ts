// Display logic for the Cockpit: gauges, the trading state and alert toasts.
import { describe, expect, it } from "vitest";
import { type Alert, type RiskView, gaugeLevel, gaugesFor, holdProgress, newAlerts, signed, tradingState } from "../src/lib/risk.ts";

const flag = (active = false, reason: string | null = null) => ({ active, reason });
const view = (o: Partial<RiskView> = {}): RiskView => ({
  equity: 9_900, cash: 7_000, dayStartEquity: 10_000, highWaterMark: 10_200, equityAt: "x", equityAgeSec: 3,
  assessment: { dailyPnl: -170, dailyPnlPct: -1.7, dailyLossLimit: 200, dailyUsedPct: 85, warn: true, limitHit: false, drawdownPct: 2.94, drawdownLimitPct: 15, drawdownHit: false },
  breakdown: { realisedToday: -120, unrealised: -40, feesToday: 10 },
  exposure: { total: 2_970, pct: 30, limitPct: 60, byPair: [] },
  limits: { dailyLossLimitBps: 200, dailyLossWarnPct: 80, maxDrawdownBps: 1500, maxExposureBps: 6000, maxAssetBps: 3000 },
  flags: { killSwitch: flag(), manualRestart: flag(), dailyLimitHit: flag(), liquidating: { active: false, since: null, ordersLeft: 0 } },
  pinRequired: true,
  ...o,
});

describe("UI-05 Cockpit risk gauges", () => {
  it("UI-05 each gauge is a share of its own limit, with a word as well as a colour", () => {
    const [daily, dd, ex] = gaugesFor(view());
    expect(daily).toMatchObject({ value: "85%", level: "warning", word: "WARNING", detail: "170.00 of 200.00 USDT" });
    expect(dd).toMatchObject({ value: "2.9%", level: "ok", word: "OK" });
    expect(dd!.usedPct).toBeCloseTo(19.6, 1);
    expect(ex).toMatchObject({ value: "30%", usedPct: 50, level: "ok" });
  });

  it("UI-05 levels: OK below the warning, WARNING from it, LIMIT at 100%", () => {
    expect(gaugeLevel(79)).toEqual({ level: "ok", word: "OK" });
    expect(gaugeLevel(80)).toEqual({ level: "warning", word: "WARNING" });
    expect(gaugeLevel(100)).toEqual({ level: "limit", word: "LIMIT" });
  });

  it("UI-05 before the first equity figure, gauges read zero instead of breaking", () => {
    const g = gaugesFor(view({ assessment: null, highWaterMark: null }));
    expect(g[0]).toMatchObject({ value: "0%", detail: "no equity yet", level: "ok" });
  });
});

describe("UI-06 kill switch panel state", () => {
  it("UI-06 trading, daily stop, closing everything, stopped", () => {
    expect(tradingState(view())).toEqual({ kind: "trading" });
    expect(tradingState(view({ flags: { ...view().flags, dailyLimitHit: flag(true, "[2026-11-24] Lost 201.00 USDT today") } }))).toEqual({ kind: "daily-stop", reason: "Lost 201.00 USDT today" });
    const liq = view({ flags: { ...view().flags, killSwitch: flag(true, "x"), liquidating: { active: true, since: "2026-11-24T10:00:00.000Z", ordersLeft: 3 } } });
    expect(tradingState(liq, Date.parse("2026-11-24T10:00:07Z"))).toEqual({ kind: "liquidating", ordersLeft: 3, sinceSec: 7 });
    expect(tradingState(view({ flags: { ...view().flags, killSwitch: flag(true, "Pressed on the dashboard."), manualRestart: flag(true, "Pressed on the dashboard.") } }))).toEqual({ kind: "stopped", reason: "Pressed on the dashboard." });
  });

  it("UI-06 hold-to-confirm fills over two seconds", () => {
    expect(holdProgress(0)).toBe(0);
    expect(holdProgress(1000)).toBe(0.5);
    expect(holdProgress(5000)).toBe(1);
    expect(signed(-5)).toBe("−5.00");
    expect(signed(12.345)).toBe("+12.35");
  });
});

describe("UI-07 alert toasts", () => {
  const a = (id: number): Alert => ({ id, level: "info", kind: "k", message: `m${id}`, orderId: null, createdAt: "x" });
  it("UI-07 the first poll only remembers where we are (no flood of old alerts); later polls toast new ones in order", () => {
    const first = newAlerts([a(5), a(4)], null);
    expect(first).toEqual({ show: [], lastSeenId: 5 });
    const next = newAlerts([a(7), a(6)], first.lastSeenId);
    expect(next.show.map((x) => x.id)).toEqual([6, 7]);
    expect(next.lastSeenId).toBe(7);
    expect(newAlerts([], 7)).toEqual({ show: [], lastSeenId: 7 });
  });
});
