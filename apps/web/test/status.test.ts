// Display logic behind the health strip and price tiles (scene 1 of the video).
// The full browser scenes are Playwright tests in phase 9.
import { describe, expect, it } from "vitest";
import { agoText, direction, exchangePill, feedPill, formatBps, formatPct, formatPrice, processPill } from "../src/lib/status.ts";

describe("UI-01 health strip labels", () => {
  it("UI-01 processes: UP gets the up arrow tone, DOWN the down tone, never-started is neutral", () => {
    expect(processPill("up")).toEqual({ label: "UP", tone: "up" });
    expect(processPill("down")).toEqual({ label: "DOWN", tone: "down" });
    expect(processPill("never-started")).toEqual({ label: "NOT STARTED", tone: "idle" });
  });

  it("UI-01 feeds: ok is UP, stale is a warning, down is DOWN, unknown is neutral", () => {
    expect(feedPill("ok")).toEqual({ label: "UP", tone: "up" });
    expect(feedPill("stale")).toEqual({ label: "STALE", tone: "warn" });
    expect(feedPill("down")).toEqual({ label: "DOWN", tone: "down" });
    expect(feedPill("unknown")).toEqual({ label: "UNKNOWN", tone: "idle" });
  });

  it("UI-01 exchange: failing is a warning before it becomes DOWN", () => {
    expect(exchangePill("ok").label).toBe("UP");
    expect(exchangePill("failing")).toEqual({ label: "FAILING", tone: "warn" });
    expect(exchangePill("unavailable")).toEqual({ label: "DOWN", tone: "down" });
    expect(exchangePill("unknown").tone).toBe("idle");
  });

  it("UI-01 every label is words, so colour is never the only signal", () => {
    const all = [
      ...(["up", "down", "never-started"] as const).map(processPill),
      ...(["ok", "stale", "down", "unknown"] as const).map(feedPill),
      ...(["ok", "failing", "unavailable", "unknown"] as const).map(exchangePill),
    ];
    for (const p of all) expect(p.label).toMatch(/^[A-Z ]{2,}$/);
  });
});

describe("UI-01 number formatting", () => {
  it("UI-01 prices keep a fixed number of decimals by size, and show a dash when missing", () => {
    expect(formatPrice(97123.4)).toBe("97,123.40");
    expect(formatPrice(201.5)).toBe("201.500");
    expect(formatPrice(0.1234567)).toBe("0.123457");
    expect(formatPrice(null)).toBe("—");
    expect(formatPrice(Number.NaN)).toBe("—");
  });

  it("UI-01 percentages carry a sign, gaps are shown in bps", () => {
    expect(formatPct(1.234)).toBe("+1.23%");
    expect(formatPct(-0.5)).toBe("-0.50%");
    expect(formatPct(0)).toBe("0.00%");
    expect(formatPct(undefined)).toBe("—");
    expect(formatBps(49.04)).toBe("49.0 bps");
    expect(formatBps(null)).toBe("—");
  });

  it("UI-01 the arrow direction follows the sign", () => {
    expect(direction(2)).toBe("up");
    expect(direction(-0.01)).toBe("down");
    expect(direction(0)).toBe("flat");
    expect(direction(null)).toBe("flat");
  });

  it("UI-01 'ago' text is short and plain", () => {
    expect(agoText(null)).toBe("no data yet");
    expect(agoText(4)).toBe("4s ago");
    expect(agoText(75)).toBe("1m 15s ago");
  });
});
