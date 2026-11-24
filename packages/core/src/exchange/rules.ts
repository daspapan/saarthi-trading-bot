// Making an order acceptable to the exchange (EX-16): price on the tick grid,
// quantity on the lot-size grid (always rounded DOWN, so we never buy more than
// planned), and an order value above the exchange's minimum.

import type { MarketRules } from "./types.ts";

/** Number of decimals in a step like 0.001 -> 3. */
export const decimalsOf = (step: number) => {
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
};

/** Rounds DOWN to the step (a small epsilon absorbs floating-point noise). */
export function floorToStep(value: number, step: number): number {
  const n = Math.floor(value / step + 1e-9);
  return Number((n * step).toFixed(decimalsOf(step)));
}

/** Rounds to the NEAREST tick. */
export function roundToTick(value: number, tick: number): number {
  return Number((Math.round(value / tick) * tick).toFixed(decimalsOf(tick)));
}

export type PreparedOrder = { ok: true; quantity: number; price: number | null } | { ok: false; reason: string };

/** Applies the exchange's rules to a planned order; explains in plain words if it can't be placed. */
export function applyRules(rules: MarketRules, quantity: number, price: number | null, refPrice: number): PreparedOrder {
  const q = floorToStep(quantity, rules.stepSize);
  const p = price === null ? null : roundToTick(price, rules.tickSize);
  if (q < rules.minQty || q <= 0) {
    return { ok: false, reason: `Quantity ${quantity} rounds down to ${q}, below the exchange minimum of ${rules.minQty} ${rules.pair.split("/")[0]}.` };
  }
  const value = q * (p ?? refPrice);
  if (value < rules.minNotional) {
    return { ok: false, reason: `Order value ${value.toFixed(2)} USDT is below the exchange minimum of ${rules.minNotional} USDT.` };
  }
  return { ok: true, quantity: q, price: p };
}

/** Paper exchange rules, similar to Binance spot. */
export const PAPER_RULES: Record<string, MarketRules> = {
  "BTC/USDT": { pair: "BTC/USDT", tickSize: 0.01, stepSize: 0.00001, minQty: 0.00001, minNotional: 5 },
  "ETH/USDT": { pair: "ETH/USDT", tickSize: 0.01, stepSize: 0.0001, minQty: 0.0001, minNotional: 5 },
  "SOL/USDT": { pair: "SOL/USDT", tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 },
};
