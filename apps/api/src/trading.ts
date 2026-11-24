// Read-only views of orders, positions and closed trades for the Orders page.
// Every P&L figure here is after fees: the UI never shows a gross number.

import { type Db, ORDER_STATES } from "@saarthi/core";

/** Fee rate used only to estimate what selling an open position now would cost. */
const EST_EXIT_FEE = 0.001;

export type OrderView = {
  id: number;
  pair: string;
  direction: string;
  side: string;
  type: string;
  state: string;
  quantity: number;
  filled: number;
  entryPrice: number | null;
  avgFillPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  events: { from: string | null; to: string; detail: string | null; at: string }[];
};

export function readOrders(db: Db, limit = 30): { states: readonly string[]; orders: OrderView[] } {
  const rows = db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit) as Record<string, any>[];
  const ev = db.prepare("SELECT from_state, to_state, detail, created_at FROM order_events WHERE order_id = ? ORDER BY id");
  return {
    states: ORDER_STATES,
    orders: rows.map((r) => ({
      id: r.id,
      pair: r.pair,
      direction: r.direction ?? (r.side === "buy" ? "long" : "exit"),
      side: r.side,
      type: r.type,
      state: r.state,
      quantity: r.quantity,
      filled: r.filled_quantity,
      entryPrice: r.entry_price,
      avgFillPrice: r.avg_fill_price,
      stopPrice: r.stop_price,
      targetPrice: r.target_price,
      error: r.error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      events: (ev.all(r.id) as Record<string, any>[]).map((e) => ({ from: e.from_state, to: e.to_state, detail: e.detail, at: e.created_at })),
    })),
  };
}

export type PositionView = {
  id: number;
  pair: string;
  quantity: number;
  avgEntry: number;
  stopPrice: number | null;
  targetPrice: number | null;
  lastPrice: number | null;
  feesPaid: number;
  /** If sold at the last price now: after the entry fee and an estimated 0.1% exit fee. */
  unrealisedPnl: number | null;
  unrealisedPct: number | null;
  /** 0 = at the stop, 1 = at the target. Null without a price or a stop/target. */
  progress: number | null;
  openedAt: string;
};

export function readPositions(db: Db): PositionView[] {
  const rows = db
    .prepare(
      `SELECT p.*, ps.last AS last_price FROM positions p LEFT JOIN price_state ps ON ps.pair = p.pair
       WHERE p.status = 'open' ORDER BY p.id`,
    )
    .all() as Record<string, any>[];
  return rows.map((p) => {
    const last: number | null = p.last_price ?? null;
    const cost = p.avg_entry * p.quantity;
    const pnl = last === null ? null : (last - p.avg_entry) * p.quantity - p.fees_paid - last * p.quantity * EST_EXIT_FEE;
    const range = p.target_price !== null && p.stop_price !== null ? p.target_price - p.stop_price : null;
    const progress = last === null || !range ? null : Math.min(1, Math.max(0, (last - p.stop_price) / range));
    return {
      id: p.id,
      pair: p.pair,
      quantity: p.quantity,
      avgEntry: p.avg_entry,
      stopPrice: p.stop_price,
      targetPrice: p.target_price,
      lastPrice: last,
      feesPaid: p.fees_paid,
      unrealisedPnl: pnl,
      unrealisedPct: pnl === null || cost === 0 ? null : (pnl / cost) * 100,
      progress,
      openedAt: p.opened_at,
    };
  });
}

export type TradeView = {
  orderId: number;
  pair: string;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  entryFee: number;
  exitFee: number | null;
  realisedPnl: number | null;
  closeReason: string | null;
  openedAt: string;
  closedAt: string;
};

export function readTrades(db: Db, limit = 50): { trades: TradeView[]; totals: { count: number; wins: number; realisedPnl: number; fees: number } } {
  const rows = db
    .prepare("SELECT * FROM orders WHERE state = 'CLOSED' AND direction = 'long' ORDER BY id DESC LIMIT ?")
    .all(limit) as Record<string, any>[];
  const trades = rows.map((r) => ({
    orderId: r.id,
    pair: r.pair,
    quantity: r.filled_quantity,
    entryPrice: r.avg_fill_price,
    exitPrice: r.exit_price,
    entryFee: r.entry_fee ?? 0,
    exitFee: r.exit_fee,
    realisedPnl: r.realised_pnl,
    closeReason: r.close_reason,
    openedAt: r.created_at,
    closedAt: r.state_since ?? r.updated_at,
  }));
  const known = trades.filter((t) => t.realisedPnl !== null);
  return {
    trades,
    totals: {
      count: trades.length,
      wins: known.filter((t) => t.realisedPnl! > 0).length,
      realisedPnl: known.reduce((s, t) => s + t.realisedPnl!, 0),
      fees: trades.reduce((s, t) => s + t.entryFee + (t.exitFee ?? 0), 0),
    },
  };
}
