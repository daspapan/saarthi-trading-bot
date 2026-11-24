// Types and pure helpers for the AI Analyst page (unit-tested, no React here).

export type Candidate =
  | { id: string; strategy: string; pair: string; direction: "long"; entry: number; stop: number; target: number; rewardToRisk: number; quantity: number; notional: number; riskAmount: number; reason: string }
  | { id: string; strategy: string; pair: string; direction: "exit"; price: number; quantity: number; reason: string };

export type SignalCard = {
  id: number;
  runId: string | null;
  createdAt: string;
  pair: string;
  direction: string;
  confidence: string | null;
  source: "ollama" | "fail-closed" | "skipped" | string;
  trigger: string | null;
  note: string | null;
  model: string | null;
  latencyMs: number | null;
  snapshotHash: string | null;
  rationale: string | null;
  triggerText: string | null;
  invalidation: string | null;
  candidate: Candidate | null;
  evidence: { name: string; aiValue: unknown; snapshotValue: number | null; match: boolean }[];
  guardrails: { passed: boolean; reasons: string[] };
};

export type Run = {
  runId: string;
  createdAt: string;
  source: string;
  trigger: string | null;
  model: string | null;
  latencyMs: number | null;
  note: string | null;
  snapshotHash: string | null;
  signals: SignalCard[];
};

/** Groups signals (newest first) into analysis runs, keeping that order. */
export function groupByRun(cards: readonly SignalCard[]): Run[] {
  const runs = new Map<string, Run>();
  for (const c of cards) {
    const key = c.runId ?? `single-${c.id}`;
    let run = runs.get(key);
    if (!run) {
      run = { runId: key, createdAt: c.createdAt, source: c.source, trigger: c.trigger, model: c.model, latencyMs: c.latencyMs, note: c.note, snapshotHash: c.snapshotHash, signals: [] };
      runs.set(key, run);
    }
    run.signals.push(c);
  }
  for (const r of runs.values()) r.signals.sort((a, b) => a.pair.localeCompare(b.pair));
  return [...runs.values()];
}

export type Tone = "up" | "down" | "warn" | "idle";

export function directionBadge(direction: string): { label: string; tone: Tone; help: string } {
  if (direction === "long") return { label: "LONG", tone: "up", help: "Buy, using the code-computed candidate." };
  if (direction === "exit") return { label: "EXIT", tone: "warn", help: "Sell what we hold." };
  if (direction === "neutral") return { label: "NEUTRAL", tone: "idle", help: "No trade." };
  return { label: direction.toUpperCase().slice(0, 12) || "INVALID", tone: "down", help: "Not a valid direction." };
}

export function sourceLabel(run: Pick<Run, "source" | "model" | "latencyMs">): string {
  if (run.source === "ollama") return `${run.model ?? "Ollama"}${run.latencyMs !== null ? ` · answered in ${(run.latencyMs / 1000).toFixed(1)} s` : ""}`;
  if (run.source === "fail-closed") return "AI unavailable: failed closed to neutral";
  if (run.source === "skipped") return "Skipped: model not called";
  return run.source;
}

/** Shows a cited value as the AI wrote it (it might not even be a number). */
export function showValue(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (v === null || v === undefined) return "—";
  return JSON.stringify(v).slice(0, 40);
}

export function runSummary(run: Run): { passed: number; rejected: number } {
  const passed = run.signals.filter((s) => s.guardrails.passed).length;
  return { passed, rejected: run.signals.length - passed };
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
