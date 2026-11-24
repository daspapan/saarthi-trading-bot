// The one interface every exchange client implements: the simulated paper exchange
// and the Binance Spot Testnet client. The executor only ever talks to this, so
// switching TRADING_MODE swaps the client and nothing else (PAPER-02).

export type Side = "buy" | "sell";
export type OrderType = "limit" | "market";
export type ExOrderStatus = "open" | "filled" | "canceled" | "rejected" | "expired";

export type ExOrder = {
  id: string;
  clientOrderId: string;
  pair: string;
  side: Side;
  type: OrderType | "stop_loss_limit" | "limit_maker";
  price: number | null;
  quantity: number;
  filled: number;
  avgPrice: number | null;
  status: ExOrderStatus;
  /** Fees in the quote asset (USDT). */
  fee: number;
};

/** A stop-loss + take-profit pair: when one fills, the exchange cancels the other. */
export type ExOco = {
  listId: string;
  clientListId: string;
  pair: string;
  status: "open" | "done";
  stop: ExOrder;
  takeProfit: ExOrder;
};

export type OcoRequest = {
  pair: string;
  quantity: number;
  stopPrice: number;
  stopLimitPrice: number;
  takeProfitPrice: number;
  clientListId: string;
  stopClientOrderId: string;
  takeProfitClientOrderId: string;
};

export type MarketRules = { pair: string; tickSize: number; stepSize: number; minQty: number; minNotional: number };

export type Balances = Record<string, { free: number; locked: number }>;

export type ExchangeErrorKind = "rate_limit" | "insufficient_balance" | "network" | "rejected" | "not_found";

/** An exchange error we can reason about: retry it, or give up with a plain reason. */
export class ExchangeError extends Error {
  readonly kind: ExchangeErrorKind;
  constructor(kind: ExchangeErrorKind, message: string) {
    super(message);
    this.name = "ExchangeError";
    this.kind = kind;
  }
  /** Worth retrying with backoff: a network blip or HTTP 429. */
  get retryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "network";
  }
}

export interface ExchangeClient {
  readonly name: "paper" | "binance-testnet";
  rules(pair: string): Promise<MarketRules>;
  balances(): Promise<Balances>;
  createOrder(req: { pair: string; side: Side; type: OrderType; quantity: number; price?: number; clientOrderId: string }): Promise<ExOrder>;
  /** By our client order ID. Null if the exchange has never seen it. */
  getOrder(pair: string, clientOrderId: string): Promise<ExOrder | null>;
  cancelOrder(pair: string, clientOrderId: string): Promise<ExOrder>;
  openOrders(pair?: string): Promise<ExOrder[]>;
  createOco(req: OcoRequest): Promise<ExOco>;
  getOco(pair: string, clientListId: string): Promise<ExOco | null>;
  cancelOco(pair: string, clientListId: string): Promise<void>;
  ping(): Promise<void>;
}

/** Base asset of a pair: "BTC/USDT" -> "BTC". */
export const baseOf = (pair: string) => pair.split("/")[0]!;
export const quoteOf = (pair: string) => pair.split("/")[1]!;
