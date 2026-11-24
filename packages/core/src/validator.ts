// The deterministic validator (rule 4): a pure function that returns a
// pass/fail line for EVERY rule, never just the first failure.
//
// Phase 3 ships the risk rules that the backtester needs, so live trading
// and backtests share exactly this code (BT-01). Phase 5 adds the rules that
// only exist live (signal schema and grounding, signal and snapshot age,
// feed health, kill switch, AI confidence, entry vs current price) and
// connects it to the order queue.

import { type SettingsFile, num } from "./config/settings.ts";
import type { Account, RiskLimits } from "./risk.ts";
import { exposureOf, riskLimitsFrom } from "./risk.ts";
import type { Candidate, EntryCandidate } from "./strategies.ts";

export type RuleResult = { rule: number; name: string; passed: boolean; message: string };

export type RiskState = {
  account: Account;
  prices: Record<string, number>;
  /** Pairs with an order that hasn't finished yet. */
  pendingPairs: string[];
  tradesToday: number;
  dailyLossLimitHit: boolean;
};

export type ValidatorLimits = RiskLimits & {
  maxTradesPerDay: number;
  minRewardToRisk: number;
  stopAtrMin: number;
  stopAtrMax: number;
};

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** Rules 5, 6, 7, 8, 9 and 11 of the spec. Pure: same input, same output. */
export function checkRiskRules(c: EntryCandidate, state: RiskState, limits: ValidatorLimits): RuleResult[] {
  const { account, prices } = state;
  const results: RuleResult[] = [];
  const add = (rule: number, name: string, passed: boolean, message: string) => results.push({ rule, name, passed, message });

  add(5, "Daily loss limit", !state.dailyLossLimitHit, state.dailyLossLimitHit
    ? "The daily loss limit has been hit; no new orders until UTC midnight."
    : "The daily loss limit has not been hit.");

  add(6, "Trades per day", state.tradesToday < limits.maxTradesPerDay,
    `${state.tradesToday} of ${limits.maxTradesPerDay} trades used today.`);

  const riskBps = account.equity > 0 ? (c.riskAmount / account.equity) * 10_000 : Infinity;
  add(7, "Risk per trade", riskBps <= limits.riskPerTradeBps + 1e-9,
    `Risk if the stop is hit: ${c.riskAmount.toFixed(2)} USDT = ${pct(riskBps)} of equity (limit ${pct(limits.riskPerTradeBps)}).`);

  const exp = exposureOf(account, prices);
  const assetAfter = (exp.byPair[c.pair] ?? 0) + c.notional;
  const totalAfter = exp.total + c.notional;
  const assetBps = (assetAfter / account.equity) * 10_000;
  const totalBps = (totalAfter / account.equity) * 10_000;
  const spotOk = c.notional * (1 + 0.001) <= account.cash + 1e-9; // spot: must be paid for in cash, never borrowed
  add(8, "Position and exposure limits",
    assetBps <= limits.maxAssetBps + 1e-9 && totalBps <= limits.maxExposureBps + 1e-9 && spotOk,
    !spotOk
      ? `Needs ${c.notional.toFixed(2)} USDT but only ${account.cash.toFixed(2)} USDT cash is free; spot trading never borrows.`
      : `${c.pair} would be ${pct(assetBps)} of equity (limit ${pct(limits.maxAssetBps)}); all positions ${pct(totalBps)} (limit ${pct(limits.maxExposureBps)}).`);

  const holding = account.positions.some((p) => p.pair === c.pair && p.quantity > 0);
  const pending = state.pendingPairs.includes(c.pair);
  add(9, "No conflicting position or order", !holding && !pending, holding
    ? `Already holding ${c.pair}.`
    : pending ? `An order for ${c.pair} is still in progress.` : `Nothing open or pending for ${c.pair}.`);

  const stopAtr = (c.entry - c.stop) / c.atr;
  const rr = (c.target - c.entry) / (c.entry - c.stop);
  add(11, "Stop distance and reward-to-risk",
    stopAtr >= limits.stopAtrMin - 1e-9 && stopAtr <= limits.stopAtrMax + 1e-9 && rr >= limits.minRewardToRisk - 1e-9,
    `Stop is ${stopAtr.toFixed(2)} ATR away (allowed ${limits.stopAtrMin} to ${limits.stopAtrMax}); reward-to-risk ${rr.toFixed(2)} (minimum ${limits.minRewardToRisk}).`);

  return results;
}

export const allPassed = (results: readonly RuleResult[]) => results.every((r) => r.passed);

// ---------- the full validator: all 12 rules ----------

export const RULE_NAMES: Record<number, string> = {
  1: "Schema and grounding",
  2: "Signal and snapshot are fresh",
  3: "Price feeds healthy and agreeing",
  4: "Kill switch off",
  5: "Daily loss limit",
  6: "Trades per day",
  7: "Risk per trade",
  8: "Position and exposure limits",
  9: "No conflicting position or order",
  10: "Confidence",
  11: "Stop distance and reward-to-risk",
  12: "Entry close to the current price",
};

export const CONFIDENCE_RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };

export type LiveLimits = ValidatorLimits & {
  maxSignalAgeMin: number;
  maxSnapshotAgeMin: number;
  maxEntryDeviationBps: number;
  minConfidence: string;
};

export function liveLimitsFrom(risk: SettingsFile): LiveLimits {
  const minConfidence = risk.minConfidence?.value;
  return {
    ...riskLimitsFrom(risk),
    maxTradesPerDay: num(risk, "maxTradesPerDay"),
    minRewardToRisk: num(risk, "minRewardToRisk"),
    stopAtrMin: num(risk, "stopAtrMin"),
    stopAtrMax: num(risk, "stopAtrMax"),
    maxSignalAgeMin: num(risk, "maxSignalAgeMin"),
    maxSnapshotAgeMin: num(risk, "maxSnapshotAgeMin"),
    maxEntryDeviationBps: num(risk, "maxEntryDeviationBps"),
    minConfidence: typeof minConfidence === "string" ? minConfidence : "medium",
  };
}

export type ValidationInput = {
  nowMs: number;
  signal: {
    pair: string;
    direction: "long" | "exit";
    confidence: string | null;
    createdAtMs: number;
    guardrailsPassed: boolean;
    guardrailReasons: string[];
  };
  snapshotCreatedAtMs: number;
  /** The candidate the signal names, looked up in the snapshot (null if it doesn't exist). */
  candidate: Candidate | null;
  feeds: { trusted: boolean; reason: string | null };
  flags: { killSwitch: boolean; manualRestart: boolean };
  state: RiskState;
  /** Latest price from price_state, not from the snapshot. */
  currentPrice: number | null;
  limits: LiveLimits;
};

const NOT_FOR_EXIT = "Not needed for an exit: selling what we hold only reduces risk.";

/**
 * The deterministic validator. Pure: no database, no network, no clock (time is
 * passed in). Same input, same output. Returns all 12 rules, in order, every time,
 * so the UI can show the full checklist, never just the first failure.
 *
 * Exits (selling what we hold) skip the rules that only limit new risk, but must
 * never sell more than we hold: spot trading can't go short.
 */
export function validateSignal(input: ValidationInput): RuleResult[] {
  const { signal, candidate, limits, state } = input;
  const out = new Map<number, RuleResult>();
  const set = (rule: number, passed: boolean, message: string) => out.set(rule, { rule, name: RULE_NAMES[rule]!, passed, message });

  // 1. The guardrails' verdict.
  set(1, signal.guardrailsPassed, signal.guardrailsPassed
    ? "Schema, grounding and injection checks all passed."
    : `The guardrails rejected it: ${signal.guardrailReasons.slice(0, 3).join(" ")}${signal.guardrailReasons.length > 3 ? " …" : ""}`);

  // 2. Freshness.
  const signalAgeMin = (input.nowMs - signal.createdAtMs) / 60_000;
  const snapshotAgeMin = (signal.createdAtMs - input.snapshotCreatedAtMs) / 60_000;
  const fresh = signalAgeMin <= limits.maxSignalAgeMin && snapshotAgeMin <= limits.maxSnapshotAgeMin && signalAgeMin >= 0 && snapshotAgeMin >= 0;
  set(2, fresh, `Signal is ${signalAgeMin.toFixed(1)} min old (limit ${limits.maxSignalAgeMin}); its snapshot was ${snapshotAgeMin.toFixed(1)} min old when the signal arrived (limit ${limits.maxSnapshotAgeMin}).`);

  // 3. Data quality.
  set(3, input.feeds.trusted, input.feeds.trusted ? "Both price feeds are live and agree." : `Price data isn't trusted right now: ${input.feeds.reason}`);

  // 4. Kill switch.
  const killed = input.flags.killSwitch || input.flags.manualRestart;
  set(4, !killed, input.flags.killSwitch
    ? "The kill switch is on."
    : input.flags.manualRestart ? "Trading is stopped until a manual restart with the PIN." : "The kill switch is off.");

  // 10. Confidence (entries only: an exit is always allowed to reduce risk).
  if (signal.direction === "long") {
    const rank = CONFIDENCE_RANK[signal.confidence ?? ""] ?? -1;
    const need = CONFIDENCE_RANK[limits.minConfidence] ?? 1;
    set(10, rank >= need, rank === 0
      ? "Low confidence is logged only, never traded."
      : rank < 0 ? "No valid confidence was given." : `Confidence is ${signal.confidence} (minimum ${limits.minConfidence}).`);
  } else {
    set(10, true, NOT_FOR_EXIT);
  }

  if (!candidate || candidate.pair !== signal.pair || candidate.direction !== signal.direction) {
    // Without a matching code-computed candidate there are no numbers to check.
    const msg = "No matching code-computed candidate, so there is nothing safe to check.";
    for (const r of [5, 6, 7, 8, 9, 11, 12]) set(r, false, msg);
  } else if (candidate.direction === "long") {
    for (const r of checkRiskRules(candidate, state, limits)) out.set(r.rule, r);
    // 12. The market hasn't moved away from the planned entry.
    if (input.currentPrice === null || !(input.currentPrice > 0)) {
      set(12, false, "No current price to compare with.");
    } else {
      const devBps = (Math.abs(candidate.entry - input.currentPrice) / input.currentPrice) * 10_000;
      set(12, devBps <= limits.maxEntryDeviationBps + 1e-9,
        `Entry ${candidate.entry} is ${(devBps / 100).toFixed(2)}% from the current price ${input.currentPrice} (limit ${(limits.maxEntryDeviationBps / 100).toFixed(2)}%).`);
    }
  } else {
    // Exit: sell only what we actually hold (no short, no borrowing).
    const held = state.account.positions.filter((p) => p.pair === candidate.pair).reduce((a, p) => a + p.quantity, 0);
    for (const r of [5, 6, 7, 11]) set(r, true, NOT_FOR_EXIT);
    const noShort = held > 0 && candidate.quantity <= held + 1e-12;
    set(8, noShort, held <= 0
      ? `We don't hold ${candidate.pair}; selling it would be a short, and spot trading never borrows.`
      : noShort ? `Selling ${candidate.quantity} of the ${held} held.` : `Would sell ${candidate.quantity} but only ${held} is held; spot trading never borrows.`);
    const pending = state.pendingPairs.includes(candidate.pair);
    set(9, !pending, pending ? `An order for ${candidate.pair} is still in progress.` : `No other order in progress for ${candidate.pair}.`);
    if (input.currentPrice === null || !(input.currentPrice > 0)) {
      set(12, false, "No current price to compare with.");
    } else {
      const devBps = (Math.abs(candidate.price - input.currentPrice) / input.currentPrice) * 10_000;
      set(12, devBps <= limits.maxEntryDeviationBps + 1e-9,
        `Exit price ${candidate.price} is ${(devBps / 100).toFixed(2)}% from the current price ${input.currentPrice} (limit ${(limits.maxEntryDeviationBps / 100).toFixed(2)}%).`);
    }
  }

  return [...out.values()].sort((a, b) => a.rule - b.rule);
}
