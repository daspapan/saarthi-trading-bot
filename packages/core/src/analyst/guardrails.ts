// Guardrails: what the AI's output must pass BEFORE the validator sees it.
// (The local equivalent of Bedrock Guardrails in Part 02.)
//
//  1. Schema: exactly the expected fields, enums only, 3-6 data points, rationale <= 80 words.
//  2. Candidate: a "long" or "exit" must name a candidate that exists in the snapshot,
//     for the same pair and direction. "neutral" names none.
//  3. Grounding: every cited data point must exist in the snapshot's facts with exactly
//     the same value, and every number written in the text must be a snapshot value.
//  4. Injection screen: instruction-like text ("ignore previous", "execute", "buy all"),
//     URLs and code are rejected outright.
//
// Every failed check adds a plain-language reason. Nothing stops at the first problem,
// so the UI can show the full list.

import { z } from "zod";
import type { Snapshot } from "./snapshot.ts";

export const DIRECTIONS = ["long", "exit", "neutral"] as const;
export const CONFIDENCES = ["high", "medium", "low"] as const;
export const MAX_RATIONALE_WORDS = 80;

export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function signalSchema(pairs: readonly string[]) {
  return z.strictObject({
    pair: z.enum(pairs as [string, ...string[]]),
    direction: z.enum(DIRECTIONS),
    candidateId: z.string().max(120).nullable(),
    confidence: z.enum(CONFIDENCES),
    dataPoints: z.array(z.strictObject({ name: z.string().max(120), value: z.number() })).min(3).max(6),
    trigger: z.string().max(300),
    invalidation: z.string().max(300),
    rationale: z.string().max(800).refine((s) => wordCount(s) <= MAX_RATIONALE_WORDS, {
      message: `Rationale is over ${MAX_RATIONALE_WORDS} words.`,
    }),
  });
}

/** What we ask the model to return: one signal per pair. */
export function modelOutputSchema(pairs: readonly string[]) {
  return z.strictObject({ signals: z.array(signalSchema(pairs)).min(1).max(pairs.length) });
}

/** JSON schema for Ollama's `format` field (constrains decoding to this shape). */
export function modelJsonSchema(pairs: readonly string[]): Record<string, unknown> {
  const { $schema: _drop, ...schema } = z.toJSONSchema(modelOutputSchema(pairs)) as Record<string, unknown>;
  return schema;
}

export type Signal = z.infer<ReturnType<typeof signalSchema>>;

// ---------- injection screen ----------

export const INJECTION_PATTERNS: { name: string; re: RegExp }[] = [
  { name: '"ignore previous instructions"', re: /\b(ignore|disregard|forget|override)\b[\s\S]{0,40}\b(previous|prior|above|earlier|all|your)\b/i },
  { name: '"execute"', re: /\bexecute\b/i },
  { name: '"buy all" / "sell all"', re: /\b(buy|sell)\s+(all|everything|max(imum)?)\b/i },
  { name: "a URL", re: /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|io|net|org|xyz|ru|ly|me)\b/i },
  { name: "code", re: /```|<\/?script|\bfunction\s*\(|=>|\b(import|require|eval|exec|fetch)\s*\(|\brm\s+-rf\b|[{}]/i },
  { name: "role-play instructions", re: /\b(system prompt|new instructions|you are now|act as)\b/i },
];

/** All strings anywhere inside a value (so a bad field can't hide inside another). */
function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => allStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => allStrings(x, out));
  return out;
}

export function screenInjection(raw: unknown): string[] {
  const text = allStrings(raw).join("\n");
  return INJECTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => `Contains instruction-like text: ${p.name}.`);
}

// ---------- numbers in text ----------

export type NumberToken = { text: string; value: number; decimals: number };

/**
 * Finds the numbers a person would read as figures: "97,412.03", "$1,250", "-0.92%", "1.8x".
 * Skips labels glued to letters ("15m", "4h", "2R") and compound words ("30-day").
 */
export function extractNumbers(text: string): NumberToken[] {
  const re = /(?<![\w.])([-+−]?)\$?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%|x|X)?(?![\w])(?!-[A-Za-z])/g;
  const out: NumberToken[] = [];
  for (const m of text.matchAll(re)) {
    const sign = m[1] === "-" || m[1] === "−" ? -1 : 1;
    const whole = m[2]!.replace(/,/g, "");
    const frac = m[3] ?? "";
    out.push({ text: m[0], value: sign * Number(whole + frac), decimals: frac ? frac.length - 1 : 0 });
  }
  return out;
}

/** Every number anywhere in the snapshot (prices, indicators, candidates, account...). */
export function snapshotNumbers(s: Snapshot): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(s);
  return out;
}

/**
 * A written number matches a snapshot value if it is that value, possibly
 * shown with fewer decimals ("97,412" for 97412.03; "1.8x" for 1.84).
 * The sign may be dropped ("down 0.92%" for -0.92).
 */
export function numberIsGrounded(t: NumberToken, allowed: readonly number[]): boolean {
  const target = Math.abs(t.value);
  return allowed.some((v) => {
    const a = Math.abs(v);
    return Math.abs(Number(a.toFixed(t.decimals)) - target) < 1e-9 || Math.abs(a - target) < 1e-9;
  });
}

const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

// ---------- the check ----------

export type GuardrailResult = { passed: boolean; reasons: string[]; signal: Signal | null };

export function checkSignal(raw: unknown, snapshot: Snapshot): GuardrailResult {
  const reasons: string[] = [];
  const pairs = snapshot.pairs.map((p) => p.pair);

  // 1. Schema
  const parsed = signalSchema(pairs.length ? pairs : ["-"]).safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const where = issue.path.join(".") || "signal";
      if (issue.code === "unrecognized_keys") reasons.push(`Unexpected field(s): ${issue.keys.join(", ")}. Only the agreed fields are allowed.`);
      else if (issue.code === "invalid_value") reasons.push(`${where} must be one of: ${issue.values.join(", ")}.`);
      else if (issue.code === "too_small" && where === "dataPoints") reasons.push("Cite at least 3 data points.");
      else if (issue.code === "too_big" && where === "dataPoints") reasons.push("Cite at most 6 data points.");
      else reasons.push(`${where}: ${issue.message}`);
    }
  }
  reasons.push(...screenInjection(raw));
  if (!parsed.success) return { passed: false, reasons, signal: null };
  const sig = parsed.data;

  // 2. Candidate consistency
  const candidate = sig.candidateId ? snapshot.candidates.find((c) => c.id === sig.candidateId) : undefined;
  if (sig.direction === "neutral") {
    if (sig.candidateId !== null) reasons.push("A neutral signal must not name a candidate.");
  } else if (!sig.candidateId) {
    reasons.push(`A "${sig.direction}" signal must name one of the snapshot's candidates.`);
  } else if (!candidate) {
    reasons.push(`Unknown candidateId "${sig.candidateId}": it is not in the snapshot.`);
  } else {
    if (candidate.pair !== sig.pair) reasons.push(`Candidate ${candidate.id} is for ${candidate.pair}, not ${sig.pair}.`);
    if (candidate.direction !== sig.direction) reasons.push(`Candidate ${candidate.id} is a "${candidate.direction}", not a "${sig.direction}".`);
  }

  // 3a. Cited data points must be snapshot facts with the same value
  const facts = new Map(snapshot.facts.map((f) => [f.name, f.value]));
  for (const dp of sig.dataPoints) {
    const truth = facts.get(dp.name);
    if (truth === undefined) reasons.push(`Data point "${dp.name}" is not in the snapshot.`);
    else if (!sameNumber(truth, dp.value)) reasons.push(`Data point "${dp.name}" says ${dp.value} but the snapshot says ${truth}.`);
  }

  // 3b. Numbers written in the text must be snapshot values. Changing a candidate's
  //     entry, stop or target gets its own clearer message.
  const allowed = snapshotNumbers(snapshot);
  const levels =
    candidate && candidate.direction === "long"
      ? [
          { name: "entry", value: candidate.entry },
          { name: "stop", value: candidate.stop },
          { name: "target", value: candidate.target },
        ]
      : [];
  for (const [field, text] of [["rationale", sig.rationale], ["trigger", sig.trigger], ["invalidation", sig.invalidation]] as const) {
    for (const t of extractNumbers(text)) {
      if (numberIsGrounded(t, allowed)) continue;
      // The closest candidate level within 2%: the AI probably meant that one and changed it.
      const near = levels
        .filter((l) => Math.abs(Math.abs(t.value) - l.value) / l.value < 0.02)
        .sort((a, b) => Math.abs(Math.abs(t.value) - a.value) - Math.abs(Math.abs(t.value) - b.value))[0];
      reasons.push(
        near
          ? `The ${field} changes the candidate's ${near.name}: ${t.text} instead of ${near.value}. Candidate numbers must be copied exactly.`
          : `The ${field} mentions ${t.text}, which is not a number in the snapshot.`,
      );
    }
  }

  return { passed: reasons.length === 0, reasons, signal: sig };
}
