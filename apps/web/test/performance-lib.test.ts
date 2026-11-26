// Performance page display logic: the calendar heat map and the returns-vs-BTC wording.
import { describe, expect, it } from "vitest";
import { calendarWeeks, heatLevel, pct, windowNote } from "../src/lib/performance.ts";

describe("UI-08 performance display", () => {
  it("UI-08 the calendar starts on a Monday and leaves days without data empty", () => {
    const weeks = calendarWeeks([
      { day: "2026-11-18", pnl: 12, pnlPct: 0.12 }, // a Wednesday
      { day: "2026-11-19", pnl: -40, pnlPct: -0.4 },
      { day: "2026-11-24", pnl: 150, pnlPct: 1.5 }, // the next Tuesday
    ]);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]![0]!.day).toBe("2026-11-16");
    expect(weeks[0]!.map((c) => c.level)).toEqual([null, null, 1, -2, null, null, null]);
    expect(weeks[1]![1]).toEqual({ day: "2026-11-24", pnl: 150, pnlPct: 1.5, level: 3 });
    expect(calendarWeeks([])).toEqual([]);
  });

  it("UI-08 colour steps by size, flat near zero", () => {
    expect([0.01, 0.1, 0.5, 2, -0.1, -5].map(heatLevel)).toEqual([0, 1, 2, 3, -1, -3]);
    expect(heatLevel(null)).toBeNull();
  });

  it("UI-08 the comparison with BTC is stated plainly, including when history is short or missing", () => {
    expect(windowNote({ days: 30, actualDays: 30, from: "x", returnPct: 2.4, btcPct: 5 })).toBe("2.6 percentage points behind simply holding BTC.");
    expect(windowNote({ days: 90, actualDays: 12, from: "x", returnPct: 1, btcPct: 0.2 })).toBe("Only 12 days of history so far. 0.8 percentage points ahead of simply holding BTC.");
    expect(windowNote({ days: 60, actualDays: 60, from: "x", returnPct: 1, btcPct: null })).toBe("No BTC price history for the start date, so no comparison.");
    expect(windowNote({ days: 30, actualDays: 0, from: null, returnPct: null, btcPct: null })).toBe("No equity recorded yet.");
    expect(pct(-1)).toBe("−1.0%");
  });
});
