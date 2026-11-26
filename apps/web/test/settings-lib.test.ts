// Strategy and Risk page display logic.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groupSettings, labelFor, pendingChanges, show, stepFor } from "../src/lib/settings.ts";

const strategy = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "config", "strategy.json"), "utf8"));

describe("UI-12 Strategy and Risk page", () => {
  it("UI-12 settings are grouped by strategy, with readable labels", () => {
    expect(groupSettings(strategy).map((g) => g.group)).toEqual(["General", "Stat-arb (BTC/ETH ratio)", "Momentum", "Mean reversion"]);
    expect(labelFor("momentum.minVolumeRatio")).toBe("Min volume ratio");
    expect(labelFor("dailyLossLimitBps")).toBe("Daily loss limit (bps)");
    expect(labelFor("momentum.stopAtr")).toBe("Stop (ATR)");
    expect(labelFor("feedStaleSeconds")).toBe("Feed stale (s)");
    expect(labelFor("statArb.zEntry")).toBe("Z entry");
  });

  it("UI-12 the diff contains only real changes", () => {
    expect(pendingChanges(strategy, { "momentum.targetR": 2, "momentum.maxRsi": 75, pairs: ["BTC/USDT", "ETH/USDT", "SOL/USDT"], nope: 1 })).toEqual({ "momentum.maxRsi": 75 });
  });

  it("UI-12 number steps fit the range, and values print plainly", () => {
    expect(stepFor({ value: 100, min: 10, max: 200 })).toBe(1);
    expect(stepFor({ value: 1500, min: 500, max: 2500 })).toBe(10);
    expect(stepFor({ value: 1.3, min: 1, max: 3 })).toBe(0.1);
    expect(stepFor({ value: 2, min: 1.5, max: 5 })).toBe(0.1);
    expect(show(["BTC/USDT", "ETH/USDT"])).toBe("BTC/USDT, ETH/USDT");
    expect(show(false)).toBe("off");
  });
});
