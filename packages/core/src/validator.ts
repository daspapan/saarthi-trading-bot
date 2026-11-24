// The deterministic validator (rule 4): a pure function that returns a
// pass/fail line for EVERY rule, never just the first failure.
//
// Phase 3 ships the risk rules that the backtester needs, so live trading
// and backtests share exactly this code (BT-01). Phase 5 adds the rules that
// only exist live (signal schema and grounding, signal and snapshot age,
// feed health, kill switch, AI confidence, entry vs current price) and
// connects it to the order queue.

import type { Account, RiskLimits } from "./risk.ts";
import { exposureOf } from "./risk.ts";
import type { EntryCandidate } from "./strategies.ts";

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
