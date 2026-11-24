// Display logic for the AI Analyst page (video scenes 2, 3 and 7).
import { describe, expect, it } from "vitest";
import { type SignalCard, directionBadge, groupByRun, nextStep, runSummary, showValue, sourceLabel } from "../src/lib/analyst.ts";

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

describe("UI-04 what happened next", () => {
  const rules = (failed: number[]) => Array.from({ length: 12 }, (_, i) => ({ rule: i + 1, name: `r${i + 1}`, passed: !failed.includes(i + 1), message: "m" }));
  const base = { direction: "long", guardrails: { passed: true, reasons: [] } };

  it("UI-04 neutral and rejected-before-validation signals say so", () => {
    expect(nextStep({ ...base, direction: "neutral", validator: null, queue: null }).text).toBe("Nothing to do: no trade proposed.");
    expect(nextStep({ direction: "invalid", guardrails: { passed: false, reasons: ["x"] }, validator: null, queue: null }).text).toBe("Rejected before the validator.");
  });

  it("UI-03 a validator failure lists the failed rules", () => {
    expect(nextStep({ ...base, validator: { passed: false, rules: rules([1, 12]) }, queue: null })).toEqual({ text: "Not queued: failed rules 1, 12.", tone: "down" });
    expect(nextStep({ ...base, validator: { passed: false, rules: rules([10]) }, queue: null }).text).toBe("Not queued: failed rule 10.");
  });

  it("UI-04 a queued signal shows its order number and queue status", () => {
    const v = { passed: true, rules: rules([]) };
    expect(nextStep({ ...base, validator: v, queue: { id: 7, status: "pending", statusReason: null, createdAt: "" } })).toEqual({ text: "Queued as order #7, waiting for the executor.", tone: "up" });
    expect(nextStep({ ...base, validator: v, queue: { id: 7, status: "discarded", statusReason: "Kill switch pressed", createdAt: "" } }).text).toBe("Order #7 discarded: Kill switch pressed");
    expect(nextStep({ ...base, validator: v, queue: { id: 7, status: "expired", statusReason: "Older than 15 minutes", createdAt: "" } }).tone).toBe("warn");
    expect(nextStep({ ...base, validator: v, queue: null }).text).toMatch(/already queued: not queued twice/);
  });
});
