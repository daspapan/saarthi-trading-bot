// A stand-in for Binance's raw REST API, backed by the paper exchange. It speaks
// Binance's wire format (string numbers, UPPERCASE enums, error codes), so the
// Binance client's mapping code is exercised end to end without keys or network.

import ccxt from "ccxt";
import { ExchangeError, type ExOrder, PaperExchange, type Db, PAPER_RULES } from "@saarthi/core";
import type { BinanceRaw } from "../src/binance.ts";

const pairOf = (symbol: string) => `${symbol.slice(0, -4)}/USDT`;
const STATUS: Record<ExOrder["status"], string> = { open: "NEW", filled: "FILLED", canceled: "CANCELED", rejected: "REJECTED", expired: "EXPIRED" };

/** The ccxt error class and Binance message ccxt would raise for this failure. */
function binanceError(err: unknown): Error {
  const e = err as ExchangeError;
  const body = (code: number) => `binance {"code":${code},"msg":"${e.message}"}`;
  switch (e.kind) {
    case "not_found": return new ccxt.OrderNotFound(body(-2013));
    case "insufficient_balance": return new ccxt.InsufficientFunds(body(-2010));
    case "rate_limit": return new ccxt.RateLimitExceeded(`binance 429 ${body(-1003)}`);
    case "network": return new ccxt.NetworkError(`ECONNRESET ${e.message}`);
    default: return new ccxt.InvalidOrder(body(-1013));
  }
}

export function rawOrder(o: ExOrder, withFills = false): Record<string, unknown> {
  const quote = o.avgPrice ? o.avgPrice * o.filled : 0;
  return {
    symbol: o.pair.replace("/", ""),
    orderId: Number(o.id),
    clientOrderId: o.clientOrderId,
    price: (o.price ?? 0).toFixed(8),
    origQty: o.quantity.toFixed(8),
    executedQty: o.filled.toFixed(8),
    cummulativeQuoteQty: quote.toFixed(8),
    status: o.filled > 0 && o.status === "open" ? "PARTIALLY_FILLED" : STATUS[o.status],
    type: o.type.toUpperCase(),
    side: o.side.toUpperCase(),
    ...(withFills && o.filled > 0 ? { fills: [{ price: String(o.avgPrice), qty: String(o.filled), commission: String(o.fee), commissionAsset: "USDT" }] } : {}),
  };
}

export function fakeBinance(db: Db, paper: PaperExchange, apiBase = "https://testnet.binance.vision/api/v3"): BinanceRaw & { calls: { method: string; params: Record<string, unknown> }[] } {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const wrap =
    <A extends Record<string, unknown>>(method: string, fn: (p: A) => Promise<unknown>) =>
    async (p: A = {} as A) => {
      calls.push({ method, params: p });
      try {
        return await fn(p);
      } catch (err) {
        throw binanceError(err);
      }
    };
  const lists = () => db.prepare("SELECT DISTINCT list_client_id FROM paper_orders WHERE list_client_id IS NOT NULL").all() as { list_client_id: string }[];

  return {
    calls,
    urls: { api: { public: apiBase, private: apiBase, v1: apiBase.replace("v3", "v1") } },
    publicGetPing: wrap("ping", async () => paper.ping().then(() => ({}))),
    publicGetExchangeInfo: wrap("exchangeInfo", async (p: { symbol?: string }) => {
      const r = PAPER_RULES[pairOf(String(p.symbol))];
      if (!r) return { symbols: [] };
      return {
        symbols: [
          {
            symbol: p.symbol,
            filters: [
              { filterType: "PRICE_FILTER", tickSize: r.tickSize.toFixed(8) },
              { filterType: "LOT_SIZE", stepSize: r.stepSize.toFixed(8), minQty: r.minQty.toFixed(8) },
              { filterType: "NOTIONAL", minNotional: r.minNotional.toFixed(8) },
            ],
          },
        ],
      };
    }),
    privateGetAccount: wrap("account", async () => ({
      balances: Object.entries(await paper.balances()).map(([asset, b]) => ({ asset, free: String(b.free), locked: String(b.locked) })),
    })),
    privatePostOrder: wrap("newOrder", async (p: Record<string, unknown>) => {
      // Binance sends numbers as strings: check the client formatted them plainly.
      for (const k of ["quantity", "price"]) if (p[k] !== undefined && !/^\d+(\.\d+)?$/.test(String(p[k]))) throw new ExchangeError("rejected", `Illegal characters found in parameter '${k}'`);
      const o = await paper.createOrder({
        pair: pairOf(String(p.symbol)),
        side: String(p.side).toLowerCase() as "buy" | "sell",
        type: String(p.type).toLowerCase() as "limit" | "market",
        quantity: Number(p.quantity),
        price: p.price === undefined ? undefined : Number(p.price),
        clientOrderId: String(p.newClientOrderId),
      });
      return rawOrder(o, true);
    }),
    privateGetOrder: wrap("getOrder", async (p: Record<string, unknown>) => {
      const o = await paper.getOrder(pairOf(String(p.symbol)), String(p.origClientOrderId));
      if (!o) throw new ExchangeError("not_found", "Order does not exist.");
      return rawOrder(o);
    }),
    privateDeleteOrder: wrap("cancelOrder", async (p: Record<string, unknown>) => {
      const o = await paper.getOrder(pairOf(String(p.symbol)), String(p.origClientOrderId));
      if (!o || o.status !== "open") throw new ExchangeError("not_found", "Unknown order sent.");
      return rawOrder(await paper.cancelOrder(pairOf(String(p.symbol)), String(p.origClientOrderId)));
    }),
    privateGetOpenOrders: wrap("openOrders", async (p: Record<string, unknown>) => {
      const list = await paper.openOrders(p.symbol ? pairOf(String(p.symbol)) : undefined);
      return list.map((o) => rawOrder(o));
    }),
    privatePostOrderListOco: wrap("newOco", async (p: Record<string, unknown>) => {
      const oco = await paper.createOco({
        pair: pairOf(String(p.symbol)),
        quantity: Number(p.quantity),
        stopPrice: Number(p.belowStopPrice),
        stopLimitPrice: Number(p.belowPrice),
        takeProfitPrice: Number(p.abovePrice),
        clientListId: String(p.listClientOrderId),
        stopClientOrderId: String(p.belowClientOrderId),
        takeProfitClientOrderId: String(p.aboveClientOrderId),
      });
      return { orderListId: 1, listClientOrderId: oco.clientListId, listOrderStatus: "EXECUTING" };
    }),
    privateGetOrderList: wrap("getOco", async (p: Record<string, unknown>) => {
      const id = String(p.origClientOrderId);
      const pair = (db.prepare("SELECT pair FROM paper_orders WHERE list_client_id = ? LIMIT 1").get(id) as { pair: string } | undefined)?.pair;
      if (!pair || !lists().some((l) => l.list_client_id === id)) throw new ExchangeError("not_found", "Order list does not exist.");
      const oco = (await paper.getOco(pair, id))!;
      return {
        orderListId: 1,
        listClientOrderId: id,
        listOrderStatus: oco.status === "open" ? "EXECUTING" : "ALL_DONE",
        orders: [oco.stop, oco.takeProfit].map((o) => ({ symbol: o.pair.replace("/", ""), orderId: Number(o.id), clientOrderId: o.clientOrderId })),
      };
    }),
    privateDeleteOrderList: wrap("cancelOco", async (p: Record<string, unknown>) => {
      const pair = pairOf(String(p.symbol));
      const oco = await paper.getOco(pair, String(p.listClientOrderId));
      if (!oco || oco.status !== "open") throw new ExchangeError("not_found", "Order list does not exist.");
      await paper.cancelOco(pair, String(p.listClientOrderId));
      return { listOrderStatus: "ALL_DONE" };
    }),
  };
}
