// One analysis run, start to finish (the analyst process calls this).
//
//   1. Can we trust the data? If the feeds are paused, record "skipped" and stop.
//      The model is not even called (AN-07).
//   2. Build the snapshot (code), hash it, build the prompt.
//   3. Ask Ollama. If it times out or returns something unusable, try once more.
//      Two failures: fail closed with "neutral, AI unavailable" (AN-04, AN-05).
//   4. Hand everything to the API, which runs the guardrails and stores the result.
//
// Never two runs at once (AN-06): a trigger that arrives mid-run is skipped.

import { randomUUID } from "node:crypto";
import type { FeedTrust } from "../feed/store.ts";
import { modelJsonSchema } from "./guardrails.ts";
import { type ChatFn } from "./ollama.ts";
import { buildPrompt } from "./prompt.ts";
import { type Snapshot, snapshotHash } from "./snapshot.ts";

export const MAX_ATTEMPTS = 2;

export type AnalysisSource = "ollama" | "fail-closed" | "skipped";

export type AnalysisSubmission = {
  runId: string;
  trigger: "schedule" | "manual";
  snapshot: Snapshot;
  snapshotHash: string;
  source: AnalysisSource;
  /** The model's parsed JSON (only when source is "ollama"). */
  output: unknown;
  rawText: string | null;
  note: string | null;
  model: string;
  latencyMs: number | null;
  attempts: number;
};

export type AnalystDeps = {
  trust: () => FeedTrust;
  buildSnapshot: () => Snapshot;
  chat: ChatFn;
  submit: (s: AnalysisSubmission) => Promise<unknown>;
  headlines?: () => string[];
  model: string;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
};

/** Parses the model's text. Usable = JSON with a `signals` array. Individual signals are judged later by the guardrails. */
export function parseModelText(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "The model's answer was not valid JSON." };
  }
  if (!value || typeof value !== "object" || !Array.isArray((value as { signals?: unknown }).signals)) {
    return { ok: false, reason: "The model's answer had no signals list." };
  }
  return { ok: true, value };
}

export class Analyst {
  private running = false;
  private deps: AnalystDeps;
  lastRun: { at: number; source: AnalysisSource; note: string | null } | null = null;

  constructor(deps: AnalystDeps) {
    this.deps = deps;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async runOnce(trigger: "schedule" | "manual"): Promise<AnalysisSubmission | null> {
    if (this.running) {
      this.deps.log?.warn({ trigger }, "An analysis is already running; this trigger is skipped.");
      return null;
    }
    this.running = true;
    try {
      const submission = await this.analyse(trigger);
      await this.deps.submit(submission);
      this.lastRun = { at: Date.now(), source: submission.source, note: submission.note };
      return submission;
    } finally {
      this.running = false;
    }
  }

  private async analyse(trigger: "schedule" | "manual"): Promise<AnalysisSubmission> {
    const runId = randomUUID();
    const snapshot = this.deps.buildSnapshot();
    const hash = snapshotHash(snapshot);
    const base = { runId, trigger, snapshot, snapshotHash: hash, model: this.deps.model };

    const trust = this.deps.trust();
    if (!trust.trusted) {
      return { ...base, source: "skipped", output: null, rawText: null, note: `skipped: data not trusted (${trust.reason})`, latencyMs: null, attempts: 0 };
    }

    const prompt = buildPrompt(snapshot, hash, this.deps.headlines?.() ?? []);
    const schema = modelJsonSchema(snapshot.pairs.map((p) => p.pair));
    let lastProblem = "";
    let lastText: string | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const { text, latencyMs } = await this.deps.chat({ ...prompt, schema });
        lastText = text;
        const parsed = parseModelText(text);
        if (parsed.ok) {
          return { ...base, source: "ollama", output: parsed.value, rawText: text, note: null, latencyMs, attempts: attempt };
        }
        lastProblem = parsed.reason;
      } catch (err) {
        lastProblem = (err as Error).message;
      }
      this.deps.log?.warn({ attempt, problem: lastProblem }, `Analysis attempt ${attempt} failed.`);
    }
    // Fail closed: no trade idea is better than a bad one.
    return { ...base, source: "fail-closed", output: null, rawText: lastText, note: `AI unavailable: ${lastProblem}`, latencyMs: null, attempts: MAX_ATTEMPTS };
  }
}

// ---------- scheduling ----------

type IntervalTimers = { setInterval: typeof setInterval; clearInterval: typeof clearInterval };

/**
 * Runs the analyst every `intervalMs` and whenever a new "Analyse now" request
 * appears. A request that arrives mid-run is not lost: it waits for the next poll.
 * Returns a stop function.
 */
export function startAnalystSchedule(opts: {
  analyst: Analyst;
  intervalMs: number;
  latestRequest: () => number;
  pollMs?: number;
  onError?: (err: unknown) => void;
  timers?: IntervalTimers;
}): () => void {
  const timers = opts.timers ?? { setInterval, clearInterval };
  const onError = opts.onError ?? (() => {});
  let lastSeen = opts.latestRequest(); // requests from before we started are old news
  const scheduled = timers.setInterval(() => {
    opts.analyst.runOnce("schedule").catch(onError);
  }, opts.intervalMs);
  const poller = timers.setInterval(() => {
    const id = opts.latestRequest();
    if (id > lastSeen && !opts.analyst.isRunning) {
      lastSeen = id;
      opts.analyst.runOnce("manual").catch(onError);
    }
  }, opts.pollMs ?? 2_000);
  return () => {
    timers.clearInterval(scheduled);
    timers.clearInterval(poller);
  };
}
