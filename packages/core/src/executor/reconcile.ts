// Reconciliation: runs every time the executor starts, BEFORE anything else (EX-12).
//
// The exchange is the truth about money; our database is the truth about intent.
// They can disagree after a crash or after the Binance testnet's monthly reset:
//
//   exchange has an order we don't know  -> cancel it (we can't manage it safely)
//   we wait for a fill the exchange never saw -> cancelled ("no record on the exchange")
//   we think we hold coins that are gone -> position closed as "reconciled"
//   we hold coins but their stop is gone  -> protect them again
//
// Every decision is audited, and the equity snapshot is refreshed from real balances.

import { appendAudit } from "../audit.ts";
import type { Db } from "../db/db.ts";
import type { ExchangeClient } from "../exchange/types.ts";
import { baseOf } from "../exchange/types.ts";
import { STEM_LENGTH, activeOrders, transition } from "./orders.ts";
import { closePosition } from "./positions.ts";

export type ReconcileReport = {
  orphansCancelled: string[];
  ordersCancelled: number[];
  positionsClosed: number[];
  reprotected: number[];
};

export async function reconcile(db: Db, client: ExchangeClient, nowMs: number): Promise<ReconcileReport> {
  const report: ReconcileReport = { orphansCancelled: [], ordersCancelled: [], positionsClosed: [], reprotected: [] };
  const audit = (kind: string, payload: object) => appendAudit(db, "reconcile", "executor", { kind, ...payload });

  // 1. Orders on the exchange that we have no record of.
  const known = new Set((db.prepare("SELECT client_order_id FROM orders").all() as { client_order_id: string }[]).map((r) => r.client_order_id));
  for (const ex of await client.openOrders()) {
    if (known.has(ex.clientOrderId.slice(0, STEM_LENGTH))) continue;
    await client.cancelOrder(ex.pair, ex.clientOrderId);
    report.orphansCancelled.push(ex.clientOrderId);
    audit("orphan_cancelled", { clientOrderId: ex.clientOrderId, pair: ex.pair, side: ex.side, quantity: ex.quantity });
  }

  // 2. Our unfinished orders, checked against the exchange.
  const balances = await client.balances();
  for (const o of activeOrders(db)) {
    if (o.state === "CONFIRM_FILL") {
      const ex = await client.getOrder(o.pair, o.client_order_id);
      if (!ex) {
        transition(db, o, "CANCELLED", "Reconciliation: the exchange has no record of this order (testnet reset?).", { error: "Missing on the exchange" }, nowMs);
        report.ordersCancelled.push(o.id);
        audit("order_missing_on_exchange", { orderId: o.id, pair: o.pair });
      }
      continue;
    }
    if (o.state === "OPEN" || o.state === "PLACE_PROTECTION") {
      const held = (balances[baseOf(o.pair)]?.free ?? 0) + (balances[baseOf(o.pair)]?.locked ?? 0);
      if (held + 1e-12 < o.filled_quantity * 0.999) {
        // The coins are gone (testnet reset): the position no longer exists.
        const pos = closePosition(db, o.pair, o.avg_fill_price ?? 0, o.filled_quantity, 0, nowMs);
        transition(db, o, "CLOSED", `Reconciliation: the exchange holds ${held} ${baseOf(o.pair)}, not ${o.filled_quantity} (testnet reset?). Position closed; real P&L unknown.`, {
          close_reason: "reconciled",
          realised_pnl: null,
        }, nowMs);
        report.positionsClosed.push(o.id);
        audit("position_missing_on_exchange", { orderId: o.id, pair: o.pair, expected: o.filled_quantity, held, positionId: pos?.id ?? null });
        continue;
      }
      if (o.state === "OPEN") {
        const oco = o.protection_list_id ? await client.getOco(o.pair, o.protection_list_id) : null;
        if (!oco) {
          transition(db, o, "PLACE_PROTECTION", "Reconciliation: coins held but the protective OCO is missing. Protecting again.", {}, nowMs);
          report.reprotected.push(o.id);
          audit("protection_missing", { orderId: o.id, pair: o.pair });
        }
      }
    }
  }

  audit("done", { ...report, counts: Object.fromEntries(Object.entries(report).map(([k, v]) => [k, (v as unknown[]).length])) });
  return report;
}

/**
 * Writes an equity snapshot from real balances: USDT plus the coins of the traded
 * pairs at current prices. (The testnet hands out many other coins; they're ignored.)
 * Keeps the high-water mark and the start-of-day equity for the risk process.
 */
export async function recordEquity(db: Db, client: ExchangeClient, pairs: readonly string[], prices: Record<string, number>, nowMs: number) {
  const bal = await client.balances();
  const usdt = bal.USDT ?? { free: 0, locked: 0 };
  let equity = usdt.free + usdt.locked;
  for (const pair of pairs) {
    const b = bal[baseOf(pair)];
    const price = prices[pair];
    if (b && price) equity += (b.free + b.locked) * price;
  }
  const last = db.prepare("SELECT equity, high_water_mark, day_start_equity, created_at FROM equity_snapshots ORDER BY id DESC LIMIT 1").get() as
    | { equity: number; high_water_mark: number; day_start_equity: number; created_at: string }
    | undefined;
  const sameDay = last && Math.floor(Date.parse(last.created_at) / 86_400_000) === Math.floor(nowMs / 86_400_000);
  const dayStart = last ? (sameDay ? last.day_start_equity : last.equity) : equity;
  const hwm = Math.max(last?.high_water_mark ?? equity, equity);
  db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (?, ?, ?, ?, ?)").run(
    equity,
    usdt.free,
    hwm,
    dayStart,
    new Date(nowMs).toISOString(),
  );
  return { equity, cash: usdt.free, highWaterMark: hwm, dayStartEquity: dayStart };
}

