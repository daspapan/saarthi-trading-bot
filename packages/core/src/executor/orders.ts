// Order records: one row per order's life, its state saved after every step
// (EX-10), with an order_events row and an audit row for every change.

import { appendAudit } from "../audit.ts";
import type { Db } from "../db/db.ts";
import type { QueueItem } from "../queue.ts";
import type { Candidate } from "../strategies.ts";

export const ORDER_STATES = [
  "QUEUED",
  "PRECHECK",
  "PLACE_ENTRY",
  "CONFIRM_FILL",
  "PLACE_PROTECTION",
  "OPEN",
  "CLOSED",
  "CANCELLED",
  "FAILED",
  "EMERGENCY_CLOSE",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

/** States that are finished: nothing more will happen to the order. */
export const TERMINAL_STATES: readonly OrderState[] = ["CLOSED", "CANCELLED", "FAILED"];

export type OrderRow = {
  id: number;
  queue_id: number | null;
  signal_id: number | null;
  client_order_id: string;
  venue: string;
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  direction: "long" | "exit";
  quantity: number;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  state: OrderState;
  state_since: string | null;
  attempts: number;
  next_attempt_at: string | null;
  exchange_order_id: string | null;
  protection_list_id: string | null;
  filled_quantity: number;
  avg_fill_price: number | null;
  entry_fee: number;
  exit_price: number | null;
  exit_fee: number | null;
  close_reason: string | null;
  realised_pnl: number | null;
  position_id: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Our client order ID: "sa" + the first 30 hex characters of the queue's dedupe ID.
 * Binance allows at most 36 characters, so the full 64-character dedupe ID can't be
 * used as-is; 120 bits is still collision-free in practice. Related orders add a
 * suffix to the same stem (-o OCO list, -s stop, -t target, -e1... emergency sells),
 * so any exchange order can be traced back to its order record.
 */
export const clientIdFor = (dedupeId: string) => `sa${dedupeId.slice(0, 30)}`;
export const STEM_LENGTH = 32;
/**
 * IDs for the protective OCO. The exchange never accepts a client ID twice, so if the
 * first OCO was cancelled outside Saarthi, the next one is generation 2 ("-o2"), and so on.
 */
export const ocoIds = (clientId: string, generation = 1) => {
  const g = generation > 1 ? String(generation) : "";
  return { list: `${clientId}-o${g}`, stop: `${clientId}-s${g}`, target: `${clientId}-t${g}` };
};

/** Which OCO generation a list ID is: "...-o" is 1, "...-o3" is 3. */
export const ocoGeneration = (listId: string | null) => {
  if (!listId) return 0;
  const m = /-o(\d*)$/.exec(listId);
  return m ? Number(m[1] || 1) : 0;
}
export const emergencyId = (clientId: string, attempt: number) => `${clientId}-e${attempt}`;

export function getOrderRow(db: Db, id: number): OrderRow {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow;
}

export function activeOrders(db: Db): OrderRow[] {
  const marks = TERMINAL_STATES.map(() => "?").join(", ");
  return db.prepare(`SELECT * FROM orders WHERE state NOT IN (${marks}) ORDER BY id`).all(...TERMINAL_STATES) as OrderRow[];
}

/** Turns a claimed queue item into an order record in state QUEUED. */
export function createOrderFromQueue(db: Db, item: QueueItem, nowMs: number): OrderRow {
  const c = item.payload.candidate as Candidate;
  const ts = new Date(nowMs).toISOString();
  const long = c.direction === "long";
  const info = db
    .prepare(
      `INSERT INTO orders (queue_id, signal_id, client_order_id, venue, pair, side, type, direction, quantity, entry_price, stop_price, target_price,
                           state, state_since, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
    )
    .run(
      item.id,
      item.signalId,
      clientIdFor(item.dedupeId),
      item.venue,
      item.pair,
      long ? "buy" : "sell",
      long ? "limit" : "market",
      c.direction,
      c.quantity,
      long ? c.entry : c.price,
      long ? c.stop : null,
      long ? c.target : null,
      ts,
      ts,
      ts,
    );
  const id = Number(info.lastInsertRowid);
  db.prepare("INSERT INTO order_events (order_id, from_state, to_state, detail, created_at) VALUES (?, NULL, 'QUEUED', ?, ?)").run(id, `From queue item #${item.id}`, ts);
  appendAudit(db, "order_state", "executor", { orderId: id, from: null, to: "QUEUED", pair: item.pair, queueId: item.id });
  return getOrderRow(db, id);
}

type Patch = Partial<Omit<OrderRow, "id" | "state" | "created_at">>;

function applyPatch(db: Db, id: number, patch: Patch, nowMs: number): void {
  const entries = Object.entries({ ...patch, updated_at: new Date(nowMs).toISOString() });
  db.prepare(`UPDATE orders SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(...(entries.map(([, v]) => v) as (string | number | null)[]), id);
}

/** Saves a state change (EX-10): the new state, an order event and an audit row, atomically. */
export function transition(db: Db, o: OrderRow, to: OrderState, detail: string, patch: Patch, nowMs: number): OrderRow {
  db.exec("BEGIN IMMEDIATE");
  try {
    applyPatch(db, o.id, { ...patch, state_since: new Date(nowMs).toISOString(), attempts: 0, next_attempt_at: null }, nowMs);
    db.prepare("UPDATE orders SET state = ? WHERE id = ?").run(to, o.id);
    db.prepare("INSERT INTO order_events (order_id, from_state, to_state, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(o.id, o.state, to, detail, new Date(nowMs).toISOString());
    appendAudit(db, "order_state", "executor", { orderId: o.id, from: o.state, to, pair: o.pair, detail });
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return getOrderRow(db, o.id);
}

/** Saves progress inside a state (retries, backoff) without changing the state. */
export function patchOrder(db: Db, o: OrderRow, patch: Patch, nowMs: number): OrderRow {
  applyPatch(db, o.id, patch, nowMs);
  return getOrderRow(db, o.id);
}

export function orderEvents(db: Db, orderId: number) {
  return db.prepare("SELECT from_state AS fromState, to_state AS toState, detail, created_at AS at FROM order_events WHERE order_id = ? ORDER BY id").all(orderId) as {
    fromState: OrderState | null;
    toState: OrderState;
    detail: string | null;
    at: string;
  }[];
}
