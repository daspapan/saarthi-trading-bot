// Binance Spot Testnet client. Implements the same ExchangeClient as the paper
// exchange, so the executor can't tell them apart (PAPER-02).
//
// We use ccxt only for signing, rate limiting and error classes, and call Binance's
// raw REST endpoints ourselves. That keeps the field mapping in one place, in plain
// view, and avoids ccxt's loadMarkets (which would also call mainnet-only endpoints).

import ccxt from "ccxt";
import {
  type Balances,
  ConfigError,
  type ExchangeClient,
  ExchangeError,
  type ExOco,
  type ExOrder,
  type ExOrderStatus,
  type MarketRules,
  type OcoRequest,
  type OrderType,
  type Side,
  assertTestnetUrl,
  decimalsOf,
} from "@saarthi/core";

/** The raw Binance endpoints we use. ccxt generates these; tests pass a fake. */
export type BinanceRaw = {
  urls: { api: Record<string, unknown> };
  publicGetExchangeInfo(p: Record<string, unknown>): Promise<any>;
  publicGetPing(p?: Record<string, unknown>): Promise<any>;
  privateGetAccount(p?: Record<string, unknown>): Promise<any>;
  privatePostOrder(p: Record<string, unknown>): Promise<any>;
  privateGetOrder(p: Record<string, unknown>): Promise<any>;
  privateDeleteOrder(p: Record<string, unknown>): Promise<any>;
  privateGetOpenOrders(p?: Record<string, unknown>): Promise<any>;
  privatePostOrderListOco(p: Record<string, unknown>): Promise<any>;
  privateGetOrderList(p: Record<string, unknown>): Promise<any>;
  privateDeleteOrderList(p: Record<string, unknown>): Promise<any>;
};

/** Taker fee on Binance Spot Testnet. Used only when Binance doesn't report the fee. */
const FALLBACK_FEE = 0.001;

export const symbolOf = (pair: string) => pair.replace("/", "");

const STATUS: Record<string, ExOrderStatus> = {
  NEW: "open",
  PARTIALLY_FILLED: "open",
  PENDING_NEW: "open",
  FILLED: "filled",
  CANCELED: "canceled",
  PENDING_CANCEL: "canceled",
  REJECTED: "rejected",
  EXPIRED: "expired",
  EXPIRED_IN_MATCH: "expired",
};
const TYPE: Record<string, ExOrder["type"]> = { LIMIT: "limit", MARKET: "market", STOP_LOSS_LIMIT: "stop_loss_limit", LIMIT_MAKER: "limit_maker" };

/** Builds the real ccxt client in sandbox mode and refuses anything that isn't testnet. */
export function makeCcxtTestnet(keys: { apiKey: string; secret: string }): BinanceRaw {
  const ex = new ccxt.binance({ apiKey: keys.apiKey, secret: keys.secret, enableRateLimit: true, options: { defaultType: "spot", adjustForTimeDifference: true } });
  ex.setSandboxMode(true);
  return ex as unknown as BinanceRaw;
}

/** Throws unless every REST base URL the client could use is the testnet. */
export function assertClientIsTestnet(raw: BinanceRaw): void {
  for (const [name, url] of Object.entries(raw.urls.api)) {
    if (typeof url !== "string") continue;
    if (!/^(public|private|v1|v3)$/.test(name)) continue;
    assertTestnetUrl(`ccxt urls.api.${name}`, url);
  }
  const used = ["public", "private"].map((k) => raw.urls.api[k]);
  if (used.some((u) => typeof u !== "string")) throw new ConfigError("The ccxt client has no testnet REST URL. Refusing to trade.");
}

/** Turns a ccxt (or any) error into one the executor can reason about. */
export function toExchangeError(err: unknown): ExchangeError {
  if (err instanceof ExchangeError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  // Order matters: RateLimitExceeded is a NetworkError, OrderNotFound is an InvalidOrder.
  if (err instanceof ccxt.RateLimitExceeded || err instanceof ccxt.DDoSProtection || /\b429\b|-1003/.test(msg)) return new ExchangeError("rate_limit", msg);
  if (err instanceof ccxt.OrderNotFound || /-2011|-2013/.test(msg)) return new ExchangeError("not_found", msg);
  if (err instanceof ccxt.InsufficientFunds || /-2010.*insufficient/i.test(msg)) return new ExchangeError("insufficient_balance", msg);
  if (err instanceof ccxt.NetworkError) return new ExchangeError("network", msg);
  if (err instanceof ccxt.BaseError) return new ExchangeError("rejected", msg);
  // A Binance error body that reached us without a ccxt class: the exchange answered "no".
  if (/"code":\s*-\d+/.test(msg)) return new ExchangeError("rejected", msg);
  // Plain socket errors (ECONNRESET, timeouts) from outside ccxt.
  return new ExchangeError("network", msg);
}

export class BinanceTestnetClient implements ExchangeClient {
  readonly name = "binance-testnet" as const;
  private raw: BinanceRaw;
  private rulesCache = new Map<string, MarketRules>();

  constructor(raw: BinanceRaw) {
    assertClientIsTestnet(raw); // rule 6, checked again here: the testnet or nothing
    this.raw = raw;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toExchangeError(err);
    }
  }

  async rules(pair: string): Promise<MarketRules> {
    const cached = this.rulesCache.get(pair);
    if (cached) return cached;
    const info = await this.call(() => this.raw.publicGetExchangeInfo({ symbol: symbolOf(pair) }));
    const s = info.symbols?.[0];
    if (!s) throw new ExchangeError("rejected", `The testnet doesn't list ${pair}.`);
    const f = (t: string) => (s.filters as { filterType: string; [k: string]: string }[]).find((x) => x.filterType === t);
    const rules: MarketRules = {
      pair,
      tickSize: Number(f("PRICE_FILTER")?.tickSize ?? 0.01),
      stepSize: Number(f("LOT_SIZE")?.stepSize ?? 0.00001),
      minQty: Number(f("LOT_SIZE")?.minQty ?? 0),
      minNotional: Number(f("NOTIONAL")?.minNotional ?? f("MIN_NOTIONAL")?.minNotional ?? 5),
    };
    this.rulesCache.set(pair, rules);
    return rules;
  }

  async balances(): Promise<Balances> {
    const acct = await this.call(() => this.raw.privateGetAccount());
    const out: Balances = {};
    for (const b of acct.balances as { asset: string; free: string; locked: string }[]) {
      const free = Number(b.free);
      const locked = Number(b.locked);
      if (free > 0 || locked > 0) out[b.asset] = { free, locked };
    }
    return out;
  }

  /** Numbers as Binance wants them: plain decimals with the market's precision, never 1e-5. */
  private async fmt(pair: string, qty: number, price?: number) {
    const r = await this.rules(pair);
    return {
      quantity: qty.toFixed(decimalsOf(r.stepSize)),
      price: price === undefined ? undefined : price.toFixed(decimalsOf(r.tickSize)),
    };
  }

  async createOrder(req: { pair: string; side: Side; type: OrderType; quantity: number; price?: number; clientOrderId: string }): Promise<ExOrder> {
    const n = await this.fmt(req.pair, req.quantity, req.price);
    const params: Record<string, unknown> = {
      symbol: symbolOf(req.pair),
      side: req.side.toUpperCase(),
      type: req.type.toUpperCase(),
      quantity: n.quantity,
      newClientOrderId: req.clientOrderId,
      newOrderRespType: "FULL",
    };
    if (req.type === "limit") Object.assign(params, { price: n.price, timeInForce: "GTC" });
    const r = await this.call(() => this.raw.privatePostOrder(params));
    return mapOrder(r, req.pair);
  }

  async getOrder(pair: string, clientOrderId: string): Promise<ExOrder | null> {
    try {
      const r = await this.call(() => this.raw.privateGetOrder({ symbol: symbolOf(pair), origClientOrderId: clientOrderId }));
      return mapOrder(r, pair);
    } catch (err) {
      if (err instanceof ExchangeError && err.kind === "not_found") return null;
      throw err;
    }
  }

  async cancelOrder(pair: string, clientOrderId: string): Promise<ExOrder> {
    const r = await this.call(() => this.raw.privateDeleteOrder({ symbol: symbolOf(pair), origClientOrderId: clientOrderId }));
    return mapOrder(r, pair);
  }

  async openOrders(pair?: string): Promise<ExOrder[]> {
    const rows = (await this.call(() => this.raw.privateGetOpenOrders(pair ? { symbol: symbolOf(pair) } : {}))) as any[];
    return rows.map((r) => mapOrder(r, pairOf(r.symbol, pair)));
  }

  async createOco(req: OcoRequest): Promise<ExOco> {
    const stop = await this.fmt(req.pair, req.quantity, req.stopLimitPrice);
    const stopTrigger = await this.fmt(req.pair, req.quantity, req.stopPrice);
    const target = await this.fmt(req.pair, req.quantity, req.takeProfitPrice);
    await this.call(() =>
      this.raw.privatePostOrderListOco({
        symbol: symbolOf(req.pair),
        side: "SELL",
        quantity: stop.quantity,
        listClientOrderId: req.clientListId,
        aboveType: "LIMIT_MAKER",
        abovePrice: target.price,
        aboveClientOrderId: req.takeProfitClientOrderId,
        belowType: "STOP_LOSS_LIMIT",
        belowStopPrice: stopTrigger.price,
        belowPrice: stop.price,
        belowTimeInForce: "GTC",
        belowClientOrderId: req.stopClientOrderId,
      }),
    );
    const oco = await this.getOco(req.pair, req.clientListId);
    if (!oco) throw new ExchangeError("network", "The OCO was accepted but can't be read back yet.");
    return oco;
  }

  async getOco(pair: string, clientListId: string): Promise<ExOco | null> {
    let list: any;
    try {
      list = await this.call(() => this.raw.privateGetOrderList({ origClientOrderId: clientListId }));
    } catch (err) {
      if (err instanceof ExchangeError && err.kind === "not_found") return null;
      throw err;
    }
    const legs = await Promise.all((list.orders as { clientOrderId: string }[]).map((o) => this.getOrder(pair, o.clientOrderId)));
    const stop = legs.find((l) => l?.type === "stop_loss_limit");
    const takeProfit = legs.find((l) => l?.type === "limit_maker");
    if (!stop || !takeProfit) return null;
    return {
      listId: String(list.orderListId),
      clientListId,
      pair,
      status: list.listOrderStatus === "ALL_DONE" ? "done" : "open",
      stop,
      takeProfit,
    };
  }

  async cancelOco(pair: string, clientListId: string): Promise<void> {
    await this.call(() => this.raw.privateDeleteOrderList({ symbol: symbolOf(pair), listClientOrderId: clientListId }));
  }

  async ping(): Promise<void> {
    await this.call(() => this.raw.publicGetPing({}));
  }
}

/** "BTCUSDT" -> "BTC/USDT" (all our pairs are quoted in USDT). */
function pairOf(symbol: string, fallback?: string): string {
  if (fallback) return fallback;
  return symbol.endsWith("USDT") ? `${symbol.slice(0, -4)}/USDT` : symbol;
}

/** One raw Binance order (any endpoint) -> our ExOrder. Fees are converted to USDT. */
export function mapOrder(r: any, pair: string): ExOrder {
  const filled = Number(r.executedQty ?? 0);
  const quote = Number(r.cummulativeQuoteQty ?? 0);
  const avgPrice = filled > 0 && quote > 0 ? quote / filled : null;
  const base = pair.split("/")[0];
  let fee = 0;
  if (Array.isArray(r.fills) && r.fills.length > 0) {
    for (const f of r.fills as { price: string; qty: string; commission: string; commissionAsset: string }[]) {
      const c = Number(f.commission);
      if (f.commissionAsset === "USDT") fee += c;
      else if (f.commissionAsset === base) fee += c * Number(f.price);
      else fee += Number(f.price) * Number(f.qty) * FALLBACK_FEE; // paid in BNB: count the USDT equivalent
    }
  } else if (quote > 0) {
    fee = quote * FALLBACK_FEE; // the order query doesn't return fills
  }
  const price = Number(r.price);
  return {
    id: String(r.orderId),
    clientOrderId: r.clientOrderId,
    pair,
    side: String(r.side).toLowerCase() as Side,
    type: TYPE[r.type] ?? "limit",
    price: price > 0 ? price : null,
    quantity: Number(r.origQty),
    filled,
    avgPrice,
    status: STATUS[r.status] ?? "open",
    fee,
  };
}
