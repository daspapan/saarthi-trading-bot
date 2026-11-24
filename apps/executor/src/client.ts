// The only place TRADING_MODE matters to the executor: which exchange client to build.
// Everything after this (state machine, reconciliation, equity) is the same code (PAPER-02).

import { ConfigError, type Db, type ExchangeClient, PaperExchange, type TradingMode } from "@saarthi/core";
import { BinanceTestnetClient, type BinanceRaw, makeCcxtTestnet } from "./binance.ts";
import type { ExchangeKeys } from "./secrets.ts";

/** Latest trade price per pair, as the feed process last wrote it. */
export function priceFromDb(db: Db) {
  const stmt = db.prepare("SELECT last FROM price_state WHERE pair = ?");
  return (pair: string): number | null => (stmt.get(pair) as { last: number | null } | undefined)?.last ?? null;
}

export function createExchangeClient(
  mode: TradingMode,
  deps: { db: Db; keys: ExchangeKeys; makeRaw?: (keys: { apiKey: string; secret: string }) => BinanceRaw },
): ExchangeClient | null {
  if (mode === "backtest") return null; // backtests run inside the API's worker thread
  if (mode === "paper") return new PaperExchange(deps.db, { price: priceFromDb(deps.db) });
  if (!deps.keys.binance) {
    throw new ConfigError("TRADING_MODE=testnet needs BINANCE_API_KEY and BINANCE_API_SECRET in .env.local (see README).");
  }
  return new BinanceTestnetClient((deps.makeRaw ?? makeCcxtTestnet)(deps.keys.binance));
}
