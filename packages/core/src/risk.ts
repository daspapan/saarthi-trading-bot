// Risk maths: exposure and position sizing. Pure functions, no I/O.
//
// Sizing answers "how much can we buy?" with the smallest of four limits:
//   1. risk per trade: if the stop is hit we lose at most riskPerTradeBps of equity
//   2. per-asset limit: this asset's position stays under maxAssetBps of equity
//   3. total exposure: all positions together stay under maxExposureBps of equity
//   4. cash: spot only, so we can never spend more than we have (no margin, no borrowing)

import { type SettingsFile, num } from "./config/settings.ts";

export type Position = {
  pair: string;
  quantity: number;
  avgEntry: number;
  /** Which strategy opened it (lets stat-arb know which holdings are its own). */
  strategy?: string;
};

export type Account = {
  equity: number;
  cash: number;
  positions: Position[];
};

export type RiskLimits = {
  riskPerTradeBps: number;
  maxAssetBps: number;
  maxExposureBps: number;
  minOrderUsdt: number;
};

export function riskLimitsFrom(risk: SettingsFile): RiskLimits {
  return {
    riskPerTradeBps: num(risk, "riskPerTradeBps"),
    maxAssetBps: num(risk, "maxAssetBps"),
    maxExposureBps: num(risk, "maxExposureBps"),
    minOrderUsdt: num(risk, "minOrderUsdt"),
  };
}

/** Fee buffer so a buy that uses "all remaining cash" still covers the 0.1% fee. */
export const FEE_BUFFER = 0.001;

export type Exposure = { total: number; byPair: Record<string, number>; totalBps: number };

/** Market value of open positions, in total and per pair. Missing prices fall back to the entry price. */
export function exposureOf(account: Account, prices: Record<string, number>): Exposure {
  const byPair: Record<string, number> = {};
  let total = 0;
  for (const p of account.positions) {
    if (p.quantity <= 0) continue;
    const value = p.quantity * (prices[p.pair] ?? p.avgEntry);
    byPair[p.pair] = (byPair[p.pair] ?? 0) + value;
    total += value;
  }
  return { total, byPair, totalBps: account.equity > 0 ? (total / account.equity) * 10_000 : 0 };
}

export type SizeResult =
  | {
      ok: true;
      quantity: number;
      notional: number;
      riskAmount: number;
      /** Which limit decided the size, for the plain-language explanation. */
      limitedBy: "risk per trade" | "per-asset limit" | "total exposure" | "cash";
    }
  | { ok: false; reason: string };

/**
 * Rounds a quantity DOWN to 6 decimals, so rounding can never break a limit.
 * The tiny 1e-6 nudge stops floating-point noise (0.063439 * 1e6 = 63438.99999...)
 * from knocking an already-rounded quantity down a step.
 */
export const floorQty = (q: number) => Math.floor(q * 1e6 + 1e-6) / 1e6;

export function sizePosition(args: {
  pair: string;
  entry: number;
  stop: number;
  account: Account;
  prices: Record<string, number>;
  limits: RiskLimits;
}): SizeResult {
  const { pair, entry, stop, account, prices, limits } = args;
  const perUnitRisk = entry - stop;
  if (!(entry > 0) || !(perUnitRisk > 0)) return { ok: false, reason: "The stop must be below the entry price." };
  if (account.equity <= 0) return { ok: false, reason: "No equity." };

  const exp = exposureOf(account, prices);
  const rooms = [
    { name: "risk per trade" as const, notional: ((account.equity * limits.riskPerTradeBps) / 10_000 / perUnitRisk) * entry },
    { name: "per-asset limit" as const, notional: (account.equity * limits.maxAssetBps) / 10_000 - (exp.byPair[pair] ?? 0) },
    { name: "total exposure" as const, notional: (account.equity * limits.maxExposureBps) / 10_000 - exp.total },
    { name: "cash" as const, notional: account.cash / (1 + FEE_BUFFER) },
  ];
  const tightest = rooms.reduce((a, b) => (b.notional < a.notional ? b : a));
  const quantity = floorQty(Math.max(0, tightest.notional) / entry);
  const notional = quantity * entry;
  if (notional < limits.minOrderUsdt) {
    return {
      ok: false,
      reason: `Order would be ${notional.toFixed(2)} USDT, below the ${limits.minOrderUsdt} USDT minimum (limited by ${tightest.name}).`,
    };
  }
  return { ok: true, quantity, notional, riskAmount: quantity * perUnitRisk, limitedBy: tightest.name };
}
