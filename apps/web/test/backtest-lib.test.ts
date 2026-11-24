// Display logic for the Backtest Lab (video scene 11: a backtest with an honest benchmark).
import { describe, expect, it } from "vitest";
import { compareRows, fmtHours, fmtPct, fmtPlainPct, fmtRatio, fmtUsd, fromDateInput, normalise, toDateInput, toneOf } from "../src/lib/backtest.ts";

const metrics = {
  startEquity: 10_000, endEquity: 11_000, totalReturn: 0.1, cagr: 0.05, sharpe: 1.234, sortino: null, maxDrawdown: 0.083,
  trades: 42, winRate: 0.45, profitFactor: 1.3, avgTradeDurationHours: 5, exposure: 0.3, totalFees: 123.456, totalSlippage: 10, days: 700,
};

describe("UI-11 Backtest Lab formatting", () => {
  it("UI-11 percentages: returns carry a sign, drawdown and win rate don't", () => {
    expect(fmtPct(0.1234)).toBe("+12.3%");
    expect(fmtPct(-0.05)).toBe("-5.0%");
    expect(fmtPlainPct(0.083)).toBe("8.3%");
    expect(fmtPlainPct(0.45, 0)).toBe("45%");
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("UI-11 ratios, durations and money", () => {
    expect(fmtRatio(1.234)).toBe("1.23");
    expect(fmtRatio(null)).toBe("—");
    expect(fmtHours(0.5)).toBe("30 min");
    expect(fmtHours(5)).toBe("5.0 h");
    expect(fmtHours(72)).toBe("3.0 days");
    expect(fmtUsd(1234.5)).toBe("$1,234.50");
    expect(fmtUsd(-12)).toBe("-$12.00");
  });

  it("UI-11 date inputs convert to UTC midnight and back", () => {
    const ms = fromDateInput("2025-03-09")!;
    expect(ms).toBe(Date.UTC(2025, 2, 9));
    expect(toDateInput(ms)).toBe("2025-03-09");
    expect(fromDateInput("")).toBeNull();
    expect(fromDateInput("09/03/2025")).toBeNull();
  });

  it("UI-11 curves are compared as % change from their own start", () => {
    expect(normalise([{ time: 1, equity: 200 }, { time: 2, equity: 250 }, { time: 3, equity: 150 }])).toEqual([
      { time: 1, pct: 0 },
      { time: 2, pct: 25 },
      { time: 3, pct: -25 },
    ]);
    expect(normalise([])).toEqual([]);
  });

  it("UI-11 the comparison table always shows the BTC buy-and-hold benchmark and fees", () => {
    const rows = compareRows([{ metrics, benchmark: { pair: "BTC/USDT", totalReturn: 0.2, cagr: 0, maxDrawdown: 0, curve: [] } }, { metrics: null }]);
    const byName = Object.fromEntries(rows);
    expect(byName["Total return"]).toEqual(["+10.0%", "—"]);
    expect(byName["BTC buy & hold"]).toEqual(["+20.0%", "—"]);
    expect(byName["Fees paid"]).toEqual(["$123.46", "—"]);
    expect(byName["Sortino"]).toEqual(["—", "—"]);
  });

  it("UI-11 colour tone follows the sign, and zero is neutral", () => {
    expect([toneOf(0.1), toneOf(-0.1), toneOf(0), toneOf(null)]).toEqual(["up", "down", "flat", "flat"]);
  });
});
