// Positions: what we hold. Opened when a buy fills, closed when the stop, the
// target, an exit signal or an emergency sale sells it. P&L always includes fees.

import type { Db } from "../db/db.ts";

export type PositionRow = {
  id: number;
  pair: string;
  order_id: number | null;
  quantity: number;
  avg_entry: number;
  stop_price: number | null;
  target_price: number | null;
  status: "open" | "closed";
  realised_pnl: number;
  fees_paid: number;
  opened_at: string;
  closed_at: string | null;
};

export function openPosition(
  db: Db,
  p: { pair: string; orderId: number; quantity: number; avgEntry: number; stop: number | null; target: number | null; fee: number; nowMs: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO positions (pair, order_id, quantity, avg_entry, stop_price, target_price, status, realised_pnl, fees_paid, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
    )
    .run(p.pair, p.orderId, p.quantity, p.avgEntry, p.stop, p.target, p.fee, new Date(p.nowMs).toISOString());
  return Number(info.lastInsertRowid);
}

export function positionForOrder(db: Db, orderId: number): PositionRow | undefined {
  return db.prepare("SELECT * FROM positions WHERE order_id = ? ORDER BY id DESC LIMIT 1").get(orderId) as PositionRow | undefined;
}

/**
 * Closes the open position in `pair` (sold `qty` at `price`, paying `fee`).
 * Realised P&L = (exit - entry) x qty - entry fee - exit fee  (EX-14, EX-15).
 */
export function closePosition(db: Db, pair: string, price: number, qty: number, fee: number, nowMs: number): { id: number; realisedPnl: number } | null {
  const pos = db.prepare("SELECT * FROM positions WHERE pair = ? AND status = 'open' ORDER BY id LIMIT 1").get(pair) as PositionRow | undefined;
  if (!pos) return null;
  const realisedPnl = (price - pos.avg_entry) * qty - pos.fees_paid - fee;
  db.prepare("UPDATE positions SET status = 'closed', realised_pnl = ?, fees_paid = fees_paid + ?, closed_at = ? WHERE id = ?").run(
    realisedPnl,
    fee,
    new Date(nowMs).toISOString(),
    pos.id,
  );
  return { id: pos.id, realisedPnl };
}
