// The simulated exchange for paper mode (and the executor's tests).
//
// It behaves like a cautious real exchange:
//  - books kept in the database (balances, orders), so restarts can be reconciled
//  - live prices from price_state, 0.1% fee and slippage on every fill
//  - a limit buy fills only when the price trades below it; a take-profit only above it
//  - a stop triggers when the price touches it and fills at the market (with slippage)
//  - an OCO's two legs share the locked quantity; when one fills the other is cancelled
//  - money and coins are locked while an order is open: you can't spend them twice
//  - client order IDs are unique: sending the same one twice is rejected (like Binance)
//
// Faults can be injected (for tests and the demo controls): an error on the next N
// calls of an operation, or a partial fill.

import type { Db } from "../db/db.ts";
import { type Costs, DEFAULT_COSTS, feeFor, withSlippage } from "../backtest/simExchange.ts";
import { PAPER_RULES } from "./rules.ts";
import {
  type Balances,
  type ExOco,
  type ExOrder,
  ExchangeError,
  type ExchangeClient,
  type ExchangeErrorKind,
  type MarketRules,
  type OcoRequest,
  type OrderType,
  type Side,
  baseOf,
} from "./types.ts";

type Row = {
  id: number;
  client_order_id: string;
  pair: string;
  side: Side;
  type: ExOrder["type"];
  price: number | null;
  stop_price: number | null;
  quantity: number;
  filled: number;
  avg_price: number | null;
  status: ExOrder["status"];
  fee: number;
  locked: number;
  list_client_id: string | null;
};

const toOrder = (r: Row): ExOrder => ({
  id: String(r.id),
  clientOrderId: r.client_order_id,
  pair: r.pair,
  side: r.side,
  type: r.type,
  price: r.price,
  quantity: r.quantity,
  filled: r.filled,
  avgPrice: r.avg_price,
  status: r.status,
  fee: r.fee,
});

export type FaultOp = "createOrder" | "createOco" | "getOrder" | "cancelOrder" | "getOco" | "balances" | "ping";

export class PaperExchange implements ExchangeClient {
  readonly name = "paper" as const;
  private faults: { op: FaultOp; kind: ExchangeErrorKind; message: string; times: number }[] = [];
  private partialNext: number | null = null;
  private db: Db;
  private price: (pair: string) => number | null;
  private costs: Costs;
  private now: () => number;

  constructor(db: Db, opts: { price: (pair: string) => number | null; costs?: Costs; now?: () => number }) {
    this.db = db;
    this.price = opts.price;
    this.costs = opts.costs ?? DEFAULT_COSTS;
    this.now = opts.now ?? Date.now;
  }

  // ---------- faults (tests and demo controls) ----------

  /** The next `times` calls of `op` fail with this error. */
  injectFault(op: FaultOp, kind: ExchangeErrorKind, times = 1, message?: string): void {
    this.faults.push({ op, kind, times, message: message ?? `Simulated ${kind.replace("_", " ")} on ${op}` });
  }

  /** The next limit-order fill only fills this share (0 to 1) of the quantity. */
  partialFillNext(share: number): void {
    this.partialNext = share;
  }

  private maybeFail(op: FaultOp): void {
    const f = this.faults.find((x) => x.op === op && x.times > 0);
    if (!f) return;
    f.times -= 1;
    throw new ExchangeError(f.kind, f.message);
  }

  // ---------- balances ----------

  /** Sets the starting balance (the paper seed calls this with 10,000 USDT). */
  static seed(db: Db, usdt: number): void {
    db.exec("DELETE FROM paper_orders; DELETE FROM paper_balances;");
    db.prepare("INSERT INTO paper_balances (asset, free, locked) VALUES ('USDT', ?, 0)").run(usdt);
  }

  private bal(asset: string): { free: number; locked: number } {
    return (this.db.prepare("SELECT free, locked FROM paper_balances WHERE asset = ?").get(asset) as { free: number; locked: number } | undefined) ?? { free: 0, locked: 0 };
  }

  private setBal(asset: string, free: number, locked: number): void {
    // Tiny negative leftovers from floating point are cleaned to zero.
    const clean = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x);
    this.db
      .prepare("INSERT INTO paper_balances (asset, free, locked) VALUES (?, ?, ?) ON CONFLICT(asset) DO UPDATE SET free = excluded.free, locked = excluded.locked")
      .run(asset, clean(free), clean(locked));
  }

  /** Moves `amount` from free to locked, or fails if there isn't enough. */
  private lock(asset: string, amount: number): void {
    const b = this.bal(asset);
    if (b.free + 1e-9 < amount) {
      throw new ExchangeError("insufficient_balance", `Not enough ${asset}: need ${amount.toFixed(8)}, have ${b.free.toFixed(8)} free.`);
    }
    this.setBal(asset, b.free - amount, b.locked + amount);
  }

  private unlock(asset: string, amount: number): void {
    const b = this.bal(asset);
    this.setBal(asset, b.free + amount, b.locked - amount);
  }

  async balances(): Promise<Balances> {
    this.maybeFail("balances");
    const out: Balances = {};
    for (const r of this.db.prepare("SELECT asset, free, locked FROM paper_balances").all() as { asset: string; free: number; locked: number }[]) {
      out[r.asset] = { free: r.free, locked: r.locked };
    }
    return out;
  }

  // ---------- orders ----------

  async rules(pair: string): Promise<MarketRules> {
    const r = PAPER_RULES[pair];
    if (!r) throw new ExchangeError("rejected", `Unknown pair ${pair}.`);
    return r;
  }

  private row(clientOrderId: string): Row | undefined {
    return this.db.prepare("SELECT * FROM paper_orders WHERE client_order_id = ?").get(clientOrderId) as Row | undefined;
  }

  private insert(o: { clientOrderId: string; pair: string; side: Side; type: ExOrder["type"]; price: number | null; stopPrice: number | null; quantity: number; locked: number; listId: string | null }): Row {
    const ts = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO paper_orders (client_order_id, pair, side, type, price, stop_price, quantity, status, locked, list_client_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(o.clientOrderId, o.pair, o.side, o.type, o.price, o.stopPrice, o.quantity, o.locked, o.listId, ts, ts);
    return this.row(o.clientOrderId)!;
  }

  /** Records a fill of `qty` at `price`, moving balances and fees. */
  private fill(r: Row, qty: number, price: number): void {
    const fee = feeFor(price * qty, this.costs);
    const base = baseOf(r.pair);
    const usdt = this.bal("USDT");
    const coin = this.bal(base);
    const share = qty / (r.quantity - r.filled); // share of what was still open
    const releasedLock = r.locked * share;
    if (r.side === "buy") {
      // The lock covered price x qty plus the fee; spend the real amount, free the rest.
      this.setBal("USDT", usdt.free + releasedLock - price * qty - fee, usdt.locked - releasedLock);
      this.setBal(base, coin.free + qty, coin.locked);
    } else {
      this.setBal(base, coin.free, coin.locked - releasedLock);
      this.setBal("USDT", usdt.free + price * qty - fee, usdt.locked);
    }
    const filled = r.filled + qty;
    const avg = ((r.avg_price ?? 0) * r.filled + price * qty) / filled;
    const status = filled >= r.quantity - 1e-12 ? "filled" : "open";
    this.db
      .prepare("UPDATE paper_orders SET filled = ?, avg_price = ?, fee = fee + ?, locked = locked - ?, status = ?, updated_at = ? WHERE id = ?")
      .run(filled, avg, fee, releasedLock, status, new Date(this.now()).toISOString(), r.id);
  }

  private cancelRow(r: Row, status: "canceled" | "expired" = "canceled"): void {
    if (r.status !== "open") return;
    // An OCO leg shares its lock with the other leg: only the last open leg releases it.
    const otherOpen = r.list_client_id
      ? (this.db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE list_client_id = ? AND status = 'open' AND id != ?").get(r.list_client_id, r.id) as { n: number }).n
      : 0;
    if (r.locked > 0 && otherOpen === 0) this.unlock(r.side === "buy" ? "USDT" : baseOf(r.pair), r.locked);
    // The partner is still open: hand the shared lock over so cancelling it later releases the coins.
    if (r.locked > 0 && otherOpen > 0) {
      this.db.prepare("UPDATE paper_orders SET locked = locked + ? WHERE list_client_id = ? AND status = 'open' AND id != ?").run(r.locked, r.list_client_id, r.id);
    }
    this.db.prepare("UPDATE paper_orders SET status = ?, locked = 0, updated_at = ? WHERE id = ?").run(status, new Date(this.now()).toISOString(), r.id);
  }

  async createOrder(req: { pair: string; side: Side; type: OrderType; quantity: number; price?: number; clientOrderId: string }): Promise<ExOrder> {
    this.maybeFail("createOrder");
    if (this.row(req.clientOrderId)) throw new ExchangeError("rejected", `Duplicate order: client order ID ${req.clientOrderId} was already used.`);
    if (!(req.quantity > 0)) throw new ExchangeError("rejected", "Quantity must be positive.");
    const rules = await this.rules(req.pair);
    const last = this.price(req.pair);
    const ref = req.price ?? last;
    if (ref === null || ref === undefined) throw new ExchangeError("rejected", `No price for ${req.pair} yet.`);
    if (req.quantity * ref < rules.minNotional) throw new ExchangeError("rejected", `Order value below the ${rules.minNotional} USDT minimum.`);

    const feeRate = this.costs.feeBps / 10_000;
    if (req.type === "limit") {
      if (!(req.price && req.price > 0)) throw new ExchangeError("rejected", "A limit order needs a price.");
      const locked = req.side === "buy" ? req.price * req.quantity * (1 + feeRate) : req.quantity;
      this.lock(req.side === "buy" ? "USDT" : baseOf(req.pair), locked);
      const r = this.insert({ clientOrderId: req.clientOrderId, pair: req.pair, side: req.side, type: "limit", price: req.price, stopPrice: null, quantity: req.quantity, locked, listId: null });
      return toOrder(r);
    }
    // Market: fills straight away at the current price, with slippage.
    if (last === null) throw new ExchangeError("rejected", `No price for ${req.pair} yet.`);
    const price = withSlippage(last, req.side, this.costs);
    const locked = req.side === "buy" ? price * req.quantity * (1 + feeRate) : req.quantity;
    this.lock(req.side === "buy" ? "USDT" : baseOf(req.pair), locked);
    const r = this.insert({ clientOrderId: req.clientOrderId, pair: req.pair, side: req.side, type: "market", price: null, stopPrice: null, quantity: req.quantity, locked, listId: null });
    this.fill(r, req.quantity, price);
    return toOrder(this.row(req.clientOrderId)!);
  }

  async getOrder(_pair: string, clientOrderId: string): Promise<ExOrder | null> {
    this.maybeFail("getOrder");
    const r = this.row(clientOrderId);
    return r ? toOrder(r) : null;
  }

  async cancelOrder(_pair: string, clientOrderId: string): Promise<ExOrder> {
    this.maybeFail("cancelOrder");
    const r = this.row(clientOrderId);
    if (!r) throw new ExchangeError("not_found", `Unknown order ${clientOrderId}.`);
    this.cancelRow(r);
    return toOrder(this.row(clientOrderId)!);
  }

  async openOrders(pair?: string): Promise<ExOrder[]> {
    const rows = (pair
      ? this.db.prepare("SELECT * FROM paper_orders WHERE status = 'open' AND pair = ? ORDER BY id").all(pair)
      : this.db.prepare("SELECT * FROM paper_orders WHERE status = 'open' ORDER BY id").all()) as Row[];
    return rows.map(toOrder);
  }

  // ---------- OCO ----------

  async createOco(req: OcoRequest): Promise<ExOco> {
    this.maybeFail("createOco");
    if (this.row(req.stopClientOrderId) || this.legs(req.clientListId).length) {
      throw new ExchangeError("rejected", `Duplicate OCO: ${req.clientListId} was already used.`);
    }
    const last = this.price(req.pair);
    if (last !== null && !(req.stopPrice < last && req.takeProfitPrice > last)) {
      throw new ExchangeError("rejected", `OCO prices are on the wrong side of the market (stop ${req.stopPrice}, target ${req.takeProfitPrice}, price ${last}).`);
    }
    this.lock(baseOf(req.pair), req.quantity); // one lock shared by both legs
    this.insert({ clientOrderId: req.stopClientOrderId, pair: req.pair, side: "sell", type: "stop_loss_limit", price: req.stopLimitPrice, stopPrice: req.stopPrice, quantity: req.quantity, locked: req.quantity, listId: req.clientListId });
    this.insert({ clientOrderId: req.takeProfitClientOrderId, pair: req.pair, side: "sell", type: "limit_maker", price: req.takeProfitPrice, stopPrice: null, quantity: req.quantity, locked: 0, listId: req.clientListId });
    return (await this.getOco(req.pair, req.clientListId))!;
  }

  private legs(clientListId: string): Row[] {
    return this.db.prepare("SELECT * FROM paper_orders WHERE list_client_id = ? ORDER BY id").all(clientListId) as Row[];
  }

  async getOco(_pair: string, clientListId: string): Promise<ExOco | null> {
    this.maybeFail("getOco");
    const legs = this.legs(clientListId);
    const sl = legs.find((r) => r.type === "stop_loss_limit");
    const tp = legs.find((r) => r.type === "limit_maker");
    if (!sl || !tp) return null;
    return {
      listId: clientListId,
      clientListId,
      pair: sl.pair,
      status: sl.status === "open" && tp.status === "open" ? "open" : "done",
      stop: toOrder(sl),
      takeProfit: toOrder(tp),
    };
  }

  async cancelOco(_pair: string, clientListId: string): Promise<void> {
    for (const r of this.legs(clientListId)) this.cancelRow(this.row(r.client_order_id)!);
  }

  async ping(): Promise<void> {
    this.maybeFail("ping");
  }

  // ---------- the matching engine ----------

  /**
   * Fills whatever the current prices allow. The executor calls this every second in
   * paper mode (a real exchange does this by itself).
   */
  process(): number {
    let fills = 0;
    for (const r of this.db.prepare("SELECT * FROM paper_orders WHERE status = 'open' ORDER BY id").all() as Row[]) {
      const cur = this.row(r.client_order_id)!;
      if (cur.status !== "open") continue; // its OCO partner filled earlier in this loop
      const last = this.price(r.pair);
      if (last === null) continue;
      const remaining = cur.quantity - cur.filled;

      if (cur.type === "limit" && cur.side === "buy" && last < cur.price!) {
        const share = this.partialNext ?? 1;
        this.partialNext = null;
        this.fill(cur, remaining * share, withSlippage(cur.price!, "buy", this.costs));
        fills += 1;
      } else if (cur.type === "limit" && cur.side === "sell" && last > cur.price!) {
        this.fill(cur, remaining, withSlippage(cur.price!, "sell", this.costs));
        fills += 1;
      } else if (cur.type === "stop_loss_limit" && last <= cur.stop_price!) {
        // Stop touched: sell at the market (no better than the stop), with slippage.
        this.fill(cur, remaining, withSlippage(Math.min(last, cur.stop_price!), "sell", this.costs));
        this.cancelPartner(cur);
        fills += 1;
      } else if (cur.type === "limit_maker" && last > cur.price!) {
        // Target traded through: our resting sell fills at its price. The stop leg's lock is shared, so use it.
        this.fillOcoTarget(cur, remaining);
        fills += 1;
      }
    }
    return fills;
  }

  private cancelPartner(r: Row): void {
    if (!r.list_client_id) return;
    const partner = this.db.prepare("SELECT * FROM paper_orders WHERE list_client_id = ? AND id != ? AND status = 'open'").get(r.list_client_id, r.id) as Row | undefined;
    if (partner) this.db.prepare("UPDATE paper_orders SET status = 'canceled', locked = 0 WHERE id = ?").run(partner.id);
  }

  private fillOcoTarget(tp: Row, qty: number): void {
    // Move the shared lock from the stop leg to the target leg, then fill it.
    const sl = this.db.prepare("SELECT * FROM paper_orders WHERE list_client_id = ? AND id != ?").get(tp.list_client_id, tp.id) as Row;
    this.db.prepare("UPDATE paper_orders SET locked = ? WHERE id = ?").run(sl.locked, tp.id);
    this.db.prepare("UPDATE paper_orders SET status = 'canceled', locked = 0 WHERE id = ?").run(sl.id);
    this.fill(this.row(tp.client_order_id)!, qty, withSlippage(tp.price!, "sell", this.costs));
  }
}

