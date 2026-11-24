// The executor's state machine (Step Functions in Part 02).
//
//   QUEUED -> PRECHECK -> PLACE_ENTRY -> CONFIRM_FILL -> PLACE_PROTECTION -> OPEN -> CLOSED
//   plus CANCELLED, FAILED and EMERGENCY_CLOSE.
//
// tick() runs every second. It claims new queue items, then moves every unfinished
// order ONE step. Each step saves its state before the next one starts (EX-10), and
// every step can safely run twice: before placing anything it asks the exchange
// whether that order already exists (by our client order ID), so a crash at any
// point resumes without duplicate orders (EX-11, EX-13).
//
// Rule 5: never an open position without a protective stop. If the OCO can't be
// placed, the position is sold at market at once (EMERGENCY_CLOSE), the kill
// switch is set and a critical alert goes out. The emergency sale keeps retrying
// until it succeeds: it never gives up quietly (EX-09).

import { appendAudit } from "../audit.ts";
import type { SettingsFile } from "../config/settings.ts";
import { num } from "../config/settings.ts";
import type { Db } from "../db/db.ts";
import { setRiskFlag } from "../feed/store.ts";
import { discardPending, takeNext } from "../queue.ts";
import { readLiveState } from "../live.ts";
import { applyRules, floorToStep, roundToTick } from "../exchange/rules.ts";
import { ExchangeError, type ExchangeClient, type ExOrder, baseOf } from "../exchange/types.ts";
import {
  type OrderRow,
  activeOrders,
  createOrderFromQueue,
  emergencyId,
  ocoGeneration,
  ocoIds,
  patchOrder,
  transition,
} from "./orders.ts";
import { closePosition, openPosition, positionForOrder } from "./positions.ts";

export const LIMIT_FILL_TIMEOUT_MS = 60_000;
export const MARKET_FILL_TIMEOUT_MS = 10_000;
/** First try plus 3 retries (EX-03). */
export const MAX_ENTRY_ATTEMPTS = 4;
export const MAX_PROTECTION_ATTEMPTS = 2;
/** Stop-limit leg: the limit sits 0.5% below the stop so it still fills in a fast fall. */
export const STOP_LIMIT_GAP = 0.005;

export type AlertLevel = "info" | "warn" | "critical";

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };

export type ExecutorDeps = {
  db: Db;
  client: ExchangeClient;
  risk: () => SettingsFile;
  now?: () => number;
  log?: Log;
  /** Exponential backoff: 1 s, 2 s, 4 s, ... capped at 30 s. */
  backoffMs?: (attempt: number) => number;
};

export const defaultBackoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1));

const silent: Log = { info: () => {}, warn: () => {}, error: () => {} };

export class Executor {
  private d: Required<ExecutorDeps>;

  constructor(deps: ExecutorDeps) {
    this.d = { now: Date.now, log: silent, backoffMs: defaultBackoff, ...deps };
  }

  private get db() {
    return this.d.db;
  }
  private get ex() {
    return this.d.client;
  }
  private now() {
    return this.d.now();
  }

  /** Alerts go into the audit log now; phase 7 turns them into toasts and notifications. */
  alert(level: AlertLevel, kind: string, message: string, extra: object = {}): void {
    appendAudit(this.db, "alert", "executor", { level, kind, message, ...extra });
    this.d.log[level === "info" ? "info" : level === "warn" ? "warn" : "error"]({ kind, ...extra }, message);
  }

  /** One pass: claim new queue items, then move each unfinished order one step. */
  async tick(): Promise<void> {
    for (let item = takeNext(this.db, this.now()); item; item = takeNext(this.db, this.now())) {
      createOrderFromQueue(this.db, item, this.now());
    }
    for (const o of activeOrders(this.db)) {
      if (o.next_attempt_at && Date.parse(o.next_attempt_at) > this.now()) continue; // backing off
      try {
        await this.step(o);
      } catch (err) {
        // Unexpected problem: keep the order where it is and try again next tick.
        this.d.log.error({ orderId: o.id, state: o.state, err: (err as Error).message }, "Executor step failed; will retry.");
      }
    }
  }

  async step(o: OrderRow): Promise<OrderRow> {
    switch (o.state) {
      case "QUEUED":
        return transition(this.db, o, "PRECHECK", "Checking positions and flags again before placing anything.", {}, this.now());
      case "PRECHECK":
        return this.precheck(o);
      case "PLACE_ENTRY":
        return this.placeEntry(o);
      case "CONFIRM_FILL":
        return this.confirmFill(o);
      case "PLACE_PROTECTION":
        return this.placeProtection(o);
      case "OPEN":
        return this.watchOpen(o);
      case "EMERGENCY_CLOSE":
        return this.emergencyClose(o);
      default:
        return o;
    }
  }

  // ---------- PRECHECK (EX-02) ----------

  private async precheck(o: OrderRow): Promise<OrderRow> {
    const live = readLiveState(this.db, this.now());
    const cancel = (why: string) => transition(this.db, o, "CANCELLED", `Aborted before placing: ${why}`, { error: why }, this.now());

    if (live.flags.killSwitch) return cancel("the kill switch is on.");
    if (live.flags.manualRestart) return cancel("trading is stopped until a manual restart.");
    const position = live.state.account.positions.find((p) => p.pair === o.pair);
    const others = this.db
      .prepare(`SELECT COUNT(*) AS n FROM orders WHERE pair = ? AND id != ? AND state IN ('PRECHECK','PLACE_ENTRY','CONFIRM_FILL','PLACE_PROTECTION','EMERGENCY_CLOSE')`)
      .get(o.pair, o.id) as { n: number };
    if (others.n > 0) return cancel(`another order for ${o.pair} is already in progress.`);

    if (o.direction === "exit") {
      if (!position || position.quantity <= 0) return cancel(`there is no ${o.pair} position to sell any more.`);
      return transition(this.db, o, "PLACE_ENTRY", "Still holding the asset: selling.", { quantity: position.quantity }, this.now());
    }

    if (live.state.dailyLossLimitHit) return cancel("the daily loss limit was hit.");
    if (!live.feeds.trusted) return cancel(`price data isn't trusted (${live.feeds.reason}).`);
    if (position && position.quantity > 0) return cancel(`a ${o.pair} position was opened since the signal.`);
    const need = o.quantity * (o.entry_price ?? 0) * 1.001;
    if (live.state.account.cash + 1e-9 < need) return cancel(`not enough cash now (${live.state.account.cash.toFixed(2)} USDT free, ${need.toFixed(2)} needed).`);
    const price = live.prices[o.pair];
    const maxDev = num(this.d.risk(), "maxEntryDeviationBps");
    if (price && o.entry_price && (Math.abs(o.entry_price - price) / price) * 10_000 > maxDev) {
      return cancel(`the price moved to ${price}, more than ${maxDev / 100}% from the entry ${o.entry_price}.`);
    }
    return transition(this.db, o, "PLACE_ENTRY", "Positions, flags, cash and price unchanged.", {}, this.now());
  }

  // ---------- PLACE_ENTRY (EX-03, EX-13, EX-16, EX-17, EX-18) ----------

  private async placeEntry(o: OrderRow): Promise<OrderRow> {
    // Idempotent: if the exchange already has this client order ID, adopt it instead of placing again.
    const existing = await this.ex.getOrder(o.pair, o.client_order_id);
    if (existing) {
      return transition(this.db, o, "CONFIRM_FILL", "The exchange already has this order (resumed after a restart).", { exchange_order_id: existing.id }, this.now());
    }

    if (o.direction === "exit") {
      // Free the coins first: the position's protective OCO holds them.
      const opener = this.db.prepare("SELECT * FROM orders WHERE pair = ? AND state = 'OPEN' AND direction = 'long' ORDER BY id DESC LIMIT 1").get(o.pair) as OrderRow | undefined;
      if (opener?.protection_list_id) {
        const oco = await this.ex.getOco(o.pair, opener.protection_list_id);
        if (oco?.status === "open") await this.ex.cancelOco(o.pair, opener.protection_list_id);
      }
    }

    const rules = await this.ex.rules(o.pair);
    const bal = await this.ex.balances();
    const qty = o.direction === "exit" ? Math.min(o.quantity, bal[baseOf(o.pair)]?.free ?? 0) : o.quantity;
    const ref = o.entry_price ?? 0;
    const prepared = applyRules(rules, qty, o.type === "limit" ? o.entry_price : null, ref);
    if (!prepared.ok) {
      this.alert("warn", "order_failed", `${o.pair}: order can't be placed. ${prepared.reason}`, { orderId: o.id });
      return transition(this.db, o, "FAILED", prepared.reason, { error: prepared.reason }, this.now());
    }

    try {
      const placed = await this.ex.createOrder({
        pair: o.pair,
        side: o.side,
        type: o.type,
        quantity: prepared.quantity,
        price: prepared.price ?? undefined,
        clientOrderId: o.client_order_id,
      });
      return transition(this.db, o, "CONFIRM_FILL", `Placed ${o.type} ${o.side} ${prepared.quantity} ${o.pair}${prepared.price ? ` at ${prepared.price}` : ""}.`, {
        exchange_order_id: placed.id,
        quantity: prepared.quantity,
        entry_price: prepared.price ?? o.entry_price,
      }, this.now());
    } catch (err) {
      return this.entryError(o, err);
    }
  }

  private entryError(o: OrderRow, err: unknown): OrderRow {
    const e = err instanceof ExchangeError ? err : new ExchangeError("network", (err as Error).message);
    if (e.kind === "insufficient_balance") {
      const why = `Not enough balance on the exchange: ${e.message}`;
      this.alert("warn", "order_failed", `${o.pair}: ${why}`, { orderId: o.id });
      return transition(this.db, o, "FAILED", why, { error: why }, this.now());
    }
    const attempts = o.attempts + 1;
    if (!e.retryable || attempts >= MAX_ENTRY_ATTEMPTS) {
      const why = e.retryable ? `Entry failed ${attempts} times: ${e.message}` : `The exchange refused the order: ${e.message}`;
      this.alert("warn", "order_failed", `${o.pair}: ${why}`, { orderId: o.id });
      return transition(this.db, o, "FAILED", why, { error: why }, this.now());
    }
    const wait = this.d.backoffMs(attempts);
    this.d.log.warn({ orderId: o.id, attempts, waitMs: wait }, `Entry attempt ${attempts} failed (${e.message}); retrying in ${wait / 1000} s.`);
    return patchOrder(this.db, o, { attempts, next_attempt_at: new Date(this.now() + wait).toISOString(), error: e.message }, this.now());
  }

  // ---------- CONFIRM_FILL (EX-04, EX-05, EX-06) ----------

  private async confirmFill(o: OrderRow): Promise<OrderRow> {
    const timeout = o.type === "market" ? MARKET_FILL_TIMEOUT_MS : LIMIT_FILL_TIMEOUT_MS;
    const age = this.now() - Date.parse(o.state_since ?? o.updated_at);
    let ex = await this.ex.getOrder(o.pair, o.client_order_id);

    if (!ex) {
      // Never assume: the exchange doesn't know the order. Wait out the timeout, then call it cancelled.
      if (age < timeout) return o;
      return transition(this.db, o, "CANCELLED", "The exchange has no record of this order.", { error: "Not found on the exchange" }, this.now());
    }

    if (ex.status === "open" && age >= timeout) {
      await this.ex.cancelOrder(o.pair, o.client_order_id);
      ex = (await this.ex.getOrder(o.pair, o.client_order_id))!; // re-read: it may have filled while we cancelled
    }
    if (ex.status === "open") return o; // keep polling

    if (ex.filled <= 0) {
      const why = ex.status === "canceled" && age >= timeout ? `Not filled within ${timeout / 1000} s, so it was cancelled.` : `The exchange ${ex.status} the order.`;
      return transition(this.db, o, "CANCELLED", why, { error: why }, this.now());
    }
    return this.onFilled(o, ex);
  }

  private async onFilled(o: OrderRow, ex: ExOrder): Promise<OrderRow> {
    const partial = ex.filled < o.quantity - 1e-12;
    if (o.direction === "exit") {
      const opener = this.db.prepare("SELECT * FROM orders WHERE pair = ? AND state = 'OPEN' AND direction = 'long' ORDER BY id DESC LIMIT 1").get(o.pair) as OrderRow | undefined;
      const pos = closePosition(this.db, o.pair, ex.avgPrice!, ex.filled, ex.fee, this.now());
      if (opener) {
        transition(this.db, opener, "CLOSED", "Closed by a stat-arb exit signal.", {
          exit_price: ex.avgPrice, exit_fee: ex.fee, close_reason: "exit-signal", realised_pnl: pos?.realisedPnl ?? null,
        }, this.now());
      }
      this.alert("info", "position_closed", `${o.pair} sold at ${ex.avgPrice} (exit signal). P&L after fees: ${(pos?.realisedPnl ?? 0).toFixed(2)} USDT.`, { orderId: o.id });
      return transition(this.db, o, "CLOSED", `Sold ${ex.filled} at ${ex.avgPrice}.`, {
        filled_quantity: ex.filled, avg_fill_price: ex.avgPrice, exit_price: ex.avgPrice, exit_fee: ex.fee, close_reason: "exit-signal", realised_pnl: pos?.realisedPnl ?? null,
      }, this.now());
    }

    // A buy filled (fully, or partly and the rest cancelled): we now HOLD coins. Record the position and protect it.
    const positionId = openPosition(this.db, { pair: o.pair, orderId: o.id, quantity: ex.filled, avgEntry: ex.avgPrice!, stop: o.stop_price, target: o.target_price, fee: ex.fee, nowMs: this.now() });
    this.alert("info", "order_filled", `${o.pair} buy filled: ${ex.filled} at ${ex.avgPrice}${partial ? ` (partial: ${ex.filled} of ${o.quantity}; the rest was cancelled)` : ""}.`, { orderId: o.id });
    return transition(this.db, o, "PLACE_PROTECTION", partial ? `Partly filled: protecting the ${ex.filled} that filled; the rest was cancelled.` : `Filled ${ex.filled} at ${ex.avgPrice}.`, {
      filled_quantity: ex.filled, avg_fill_price: ex.avgPrice, entry_fee: ex.fee, position_id: positionId,
    }, this.now());
  }

  // ---------- PLACE_PROTECTION (EX-07, EX-08) ----------

  private async placeProtection(o: OrderRow): Promise<OrderRow> {
    // A fresh generation if an earlier OCO for this order is no longer working.
    const ids = ocoIds(o.client_order_id, ocoGeneration(o.protection_list_id) + 1);
    const existing = await this.ex.getOco(o.pair, ids.list);
    if (existing && existing.status === "open") {
      return transition(this.db, o, "OPEN", "The protective OCO was already on the exchange.", { protection_list_id: ids.list }, this.now());
    }
    try {
      const rules = await this.ex.rules(o.pair);
      const bal = await this.ex.balances();
      // Protect exactly what we hold from this fill (a fee taken in the coin would make it slightly less).
      const qty = floorToStep(Math.min(o.filled_quantity, bal[baseOf(o.pair)]?.free ?? 0), rules.stepSize);
      const stop = roundToTick(o.stop_price!, rules.tickSize);
      await this.ex.createOco({
        pair: o.pair,
        quantity: qty,
        stopPrice: stop,
        stopLimitPrice: roundToTick(stop * (1 - STOP_LIMIT_GAP), rules.tickSize),
        takeProfitPrice: roundToTick(o.target_price!, rules.tickSize),
        clientListId: ids.list,
        stopClientOrderId: ids.stop,
        takeProfitClientOrderId: ids.target,
      });
      return transition(this.db, o, "OPEN", `Protected: stop ${stop}, target ${roundToTick(o.target_price!, rules.tickSize)} for ${qty} ${baseOf(o.pair)}.`, { protection_list_id: ids.list }, this.now());
    } catch (err) {
      const e = err instanceof ExchangeError ? err : new ExchangeError("network", (err as Error).message);
      const attempts = o.attempts + 1;
      if (e.retryable && attempts < MAX_PROTECTION_ATTEMPTS) {
        return patchOrder(this.db, o, { attempts, next_attempt_at: new Date(this.now() + this.d.backoffMs(attempts)).toISOString(), error: e.message }, this.now());
      }
      // Rule 5: never unprotected. Sell now, stop all new trading, shout.
      setRiskFlag(this.db, "kill_switch", true, `Protective stop for ${o.pair} could not be placed: ${e.message}`, this.now());
      discardPending(this.db, "Kill switch: a protective stop could not be placed.");
      this.alert("critical", "protection_failed", `${o.pair}: could not place the protective stop (${e.message}). Selling the position at market now and turning on the kill switch.`, { orderId: o.id });
      return transition(this.db, o, "EMERGENCY_CLOSE", `Protection failed: ${e.message}`, { error: e.message }, this.now());
    }
  }

  // ---------- OPEN (EX-14, EX-15) ----------

  private async watchOpen(o: OrderRow): Promise<OrderRow> {
    if (!o.protection_list_id) return transition(this.db, o, "PLACE_PROTECTION", "Open without a recorded OCO: protecting it.", {}, this.now());
    const oco = await this.ex.getOco(o.pair, o.protection_list_id);
    if (!oco || oco.status === "open") return o;

    const leg = oco.stop.status === "filled" ? oco.stop : oco.takeProfit.status === "filled" ? oco.takeProfit : null;
    if (!leg) {
      // Both legs cancelled. If an exit order is taking care of it, wait; otherwise we'd be unprotected.
      const exiting = this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE pair = ? AND direction = 'exit' AND state NOT IN ('CLOSED','CANCELLED','FAILED')").get(o.pair) as { n: number };
      if (exiting.n > 0) return o;
      const pos = positionForOrder(this.db, o.id);
      if (!pos || pos.status !== "open") return o;
      this.alert("warn", "protection_missing", `${o.pair}: the protective OCO was cancelled outside Saarthi. Placing it again.`, { orderId: o.id });
      return transition(this.db, o, "PLACE_PROTECTION", "OCO cancelled outside Saarthi: protecting again.", {}, this.now());
    }

    const reason = leg === oco.stop ? "stop" : "target";
    const pos = closePosition(this.db, o.pair, leg.avgPrice!, leg.filled, leg.fee, this.now());
    const pnl = pos?.realisedPnl ?? 0;
    this.alert(reason === "stop" ? "warn" : "info", reason === "stop" ? "stop_hit" : "target_hit",
      `${o.pair} ${reason === "stop" ? "stop" : "target"} hit at ${leg.avgPrice}. P&L after fees: ${pnl.toFixed(2)} USDT.`, { orderId: o.id });
    return transition(this.db, o, "CLOSED", `${reason === "stop" ? "Stop" : "Target"} hit at ${leg.avgPrice}. P&L after fees ${pnl.toFixed(2)} USDT.`, {
      exit_price: leg.avgPrice, exit_fee: leg.fee, close_reason: reason, realised_pnl: pnl,
    }, this.now());
  }

  // ---------- EMERGENCY_CLOSE (EX-08, EX-09) ----------

  private async emergencyClose(o: OrderRow): Promise<OrderRow> {
    // If an earlier attempt already went through, the coins are gone: done.
    for (let n = 1; n <= o.attempts + 1; n++) {
      const prev = await this.ex.getOrder(o.pair, emergencyId(o.client_order_id, n));
      if (prev && prev.status === "filled") return this.emergencyDone(o, prev);
    }
    try {
      const rules = await this.ex.rules(o.pair);
      const bal = await this.ex.balances();
      const qty = floorToStep(Math.min(o.filled_quantity, bal[baseOf(o.pair)]?.free ?? 0), rules.stepSize);
      if (qty < rules.minQty) {
        // Nothing left to sell (e.g. sold by hand): the position is flat.
        const pos = closePosition(this.db, o.pair, o.avg_fill_price ?? 0, 0, 0, this.now());
        return transition(this.db, o, "CLOSED", "Nothing left to sell: the position is already flat.", { close_reason: "emergency", realised_pnl: pos?.realisedPnl ?? null }, this.now());
      }
      const sold = await this.ex.createOrder({ pair: o.pair, side: "sell", type: "market", quantity: qty, clientOrderId: emergencyId(o.client_order_id, o.attempts + 1) });
      if (sold.status === "filled") return this.emergencyDone(o, sold);
      return patchOrder(this.db, o, { attempts: o.attempts + 1 }, this.now());
    } catch (err) {
      const attempts = o.attempts + 1;
      const wait = this.d.backoffMs(attempts);
      // Never fails quietly: every failure is a critical alert, and it keeps trying.
      this.alert("critical", "emergency_close_failed", `${o.pair}: emergency sale attempt ${attempts} failed (${(err as Error).message}). Retrying in ${wait / 1000} s. The position is UNPROTECTED: check the exchange.`, { orderId: o.id });
      return patchOrder(this.db, o, { attempts, next_attempt_at: new Date(this.now() + wait).toISOString(), error: (err as Error).message }, this.now());
    }
  }

  private emergencyDone(o: OrderRow, sold: ExOrder): OrderRow {
    const pos = closePosition(this.db, o.pair, sold.avgPrice!, sold.filled, sold.fee, this.now());
    this.alert("critical", "emergency_closed", `${o.pair}: emergency sale done at ${sold.avgPrice}. P&L after fees: ${(pos?.realisedPnl ?? 0).toFixed(2)} USDT. The kill switch stays on until you restart it.`, { orderId: o.id });
    return transition(this.db, o, "CLOSED", `Emergency sale: ${sold.filled} at ${sold.avgPrice}.`, {
      exit_price: sold.avgPrice, exit_fee: sold.fee, close_reason: "emergency", realised_pnl: pos?.realisedPnl ?? null,
    }, this.now());
  }
}
