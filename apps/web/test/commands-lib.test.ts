// Command palette, shortcuts, glossary and number tickers.
import { describe, expect, it } from "vitest";
import { filterCommands, isTypingTarget, matchShortcut, score } from "../src/lib/commands.ts";
import { GLOSSARY, explain } from "../src/lib/glossary.ts";
import { easeOutCubic, tween } from "../src/lib/ticker.ts";

describe("UI-09 command palette", () => {
  it("UI-09 typing finds pages and actions, best match first", () => {
    expect(filterCommands("kill")[0]!.id).toBe("kill");
    expect(filterCommands("perf")[0]!.id).toBe("go-performance");
    expect(filterCommands("ordrs")[0]!.id).toBe("go-orders"); // a typo still finds it
    expect(filterCommands("hash").map((c) => c.id)).toContain("go-audit"); // matches the hint
    expect(filterCommands("zzzz")).toEqual([]);
    expect(filterCommands("")).toHaveLength(12);
    expect(score("", "x")).toBe(0);
  });

  it("UI-09 shortcuts: 'g' then a letter, single keys, and nothing while typing in a field", () => {
    const first = matchShortcut("", "g");
    expect(first).toEqual({ command: null, pending: "g" });
    expect(matchShortcut(first.pending, "o").command!.href).toBe("/orders");
    expect(matchShortcut("g", "x")).toEqual({ command: null, pending: "" });
    expect(matchShortcut("", "?").command!.action).toBe("help");
    expect(matchShortcut("", "q")).toEqual({ command: null, pending: "" });
    expect(isTypingTarget("INPUT")).toBe(true);
    expect(isTypingTarget("DIV", true)).toBe(true);
    expect(isTypingTarget("BUTTON")).toBe(false);
  });
});

describe("UI-10 plain-language tooltips", () => {
  it("UI-10 every term the spec names has an explanation", () => {
    for (const t of ["RSI", "ATR", "drawdown", "OCO"]) expect(explain(t)!.length).toBeGreaterThan(40);
    expect(explain("oco")).toBe(GLOSSARY.OCO);
    expect(explain("unknown thing")).toBeNull();
  });
});

describe("UI-11 rolling numbers", () => {
  it("UI-11 eases out and lands exactly on the new value", () => {
    expect(tween(100, 200, 0)).toBe(100);
    expect(tween(100, 200, 1)).toBe(200);
    expect(tween(100, 200, 0.5)).toBeGreaterThan(150); // fast start, gentle finish
    expect(easeOutCubic(2)).toBe(1);
  });
});
