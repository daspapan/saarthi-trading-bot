// The simulated exchange used by the backtester (and later by paper mode).
// Deliberately pessimistic so backtests don't flatter the strategy:
//   - every fill pays the fee (0.1% by default) AND slippage
//   - a limit buy fills only if the price trades THROUGH it (low < limit), not just touches it
//   - a stop is filled at the stop or worse (if the candle opens below it, at the open)
//   - if a candle touches both stop and target, we assume the stop came first

import type { Candle } from "../feed/candles.ts";

export type Costs = { feeBps: number; slippageBps: number };
export const DEFAULT_COSTS: Costs = { feeBps: 10, slippageBps: 5 };

export type Fill = { price: number; fee: number; slippage: number };

/** Applies slippage against us: buys fill higher, sells fill lower. */
export function withSlippage(price: number, side: "buy" | "sell", costs: Costs): number {
  const f = costs.slippageBps / 10_000;
  return side === "buy" ? price * (1 + f) : price * (1 - f);
}

export function feeFor(notional: number, costs: Costs): number {
  return (notional * costs.feeBps) / 10_000;
}

function fill(base: number, side: "buy" | "sell", quantity: number, costs: Costs): Fill {
  const price = withSlippage(base, side, costs);
  return { price, fee: feeFor(price * quantity, costs), slippage: Math.abs(price - base) * quantity };
}

/** Limit buy at `limit`: fills only if the candle trades below it. Opening below the limit fills at the open. */
export function tryLimitBuy(candle: Candle, limit: number, quantity: number, costs: Costs): Fill | null {
  if (!(candle.low < limit)) return null;
  return fill(Math.min(candle.open, limit), "buy", quantity, costs);
}

/** Market order at the next candle's open. */
export function marketAtOpen(candle: Candle, side: "buy" | "sell", quantity: number, costs: Costs): Fill {
  return fill(candle.open, side, quantity, costs);
}

export type ExitCheck = { reason: "stop" | "target"; fill: Fill } | null;

/**
 * Checks a long position's stop and target against one candle.
 * `allowTarget` is false on the candle the entry filled in: we can't know
 * whether the high came before or after our fill, so only the stop counts.
 */
export function checkStopAndTarget(
  candle: Candle,
  stop: number,
  target: number,
  quantity: number,
  costs: Costs,
  allowTarget = true,
): ExitCheck {
  if (candle.low <= stop) {
    return { reason: "stop", fill: fill(Math.min(stop, candle.open), "sell", quantity, costs) };
  }
  if (allowTarget && candle.high > target) {
    return { reason: "target", fill: fill(Math.max(target, candle.open), "sell", quantity, costs) };
  }
  return null;
}
