// Display logic for the AI Analyst page (video scenes 2, 3 and 7).
import { describe, expect, it } from "vitest";
import { type SignalCard, directionBadge, groupByRun, runSummary, showValue, sourceLabel } from "../src/lib/analyst.ts";

const card = (o: Partial<SignalCard>): SignalCard => ({
  id: 1, runId: "r1", createdAt: "2026-01-01T10:00:00Z", pair: "BTC/USDT", direction: "neutral", confidence: null, source: "ollama",
  trigger: "manual", note: null, model: "qwen2.5:7b", latencyMs: 4200, snapshotHash: "h", rationale: null, triggerText: null,
  invalidation: null, candidate: null, evidence: [], guardrails: { passed: true, reasons: [] }, ...o,
});

describe("UI-02 AI Analyst display", () => {
  it("UI-02 signals are grouped into analysis runs, newest run first, pairs in order inside a run", () => {
    const runs = groupByRun([
      card({ id: 4, runId: "r2", pair: "SOL/USDT" }),
      card({ id: 3, runId: "r2", pair: "BTC/USDT" }),
      card({ id: 2, runId: "r1", pair: "ETH/USDT" }),
      card({ id: 1, runId: "r1", pair: "BTC/USDT" }),
    ]);
    expect(runs.map((r) => r.runId)).toEqual(["r2", "r1"]);
    expect(runs[0]!.signals.map((s) => s.pair)).toEqual(["BTC/USDT", "SOL/USDT"]);
  });

  it("UI-02 direction badges are words plus a tone; 'short' can never look valid", () => {
    expect(directionBadge("long")).toMatchObject({ label: "LONG", tone: "up" });
    expect(directionBadge("exit")).toMatchObject({ label: "EXIT", tone: "warn" });
    expect(directionBadge("neutral")).toMatchObject({ label: "NEUTRAL", tone: "idle" });
    expect(directionBadge("short")).toMatchObject({ label: "SHORT", tone: "down", help: "Not a valid direction." });
    expect(directionBadge("")).toMatchObject({ label: "INVALID" });
  });

  it("UI-03 the run header says where the answer came from", () => {
    expect(sourceLabel({ source: "ollama", model: "qwen2.5:7b", latencyMs: 4200 })).toBe("qwen2.5:7b · answered in 4.2 s");
    expect(sourceLabel({ source: "fail-closed", model: null, latencyMs: null })).toBe("AI unavailable: failed closed to neutral");
    expect(sourceLabel({ source: "skipped", model: null, latencyMs: null })).toBe("Skipped: model not called");
  });

  it("UI-03 counts passed and rejected signals per run", () => {
    const [run] = groupByRun([card({ id: 2, guardrails: { passed: false, reasons: ["x"] } }), card({ id: 1 })]);
    expect(runSummary(run!)).toEqual({ passed: 1, rejected: 1 });
  });

  it("UI-07 cited values are shown exactly as the AI wrote them, even when they aren't numbers", () => {
    expect(showValue(61.25)).toBe("61.25");
    expect(showValue("sixty")).toBe('"sixty"');
    expect(showValue(null)).toBe("—");
  });
});
