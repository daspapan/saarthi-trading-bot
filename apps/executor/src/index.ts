// Executor process: the only process that holds exchange keys.
// Phase 1: loads keys (if present) and reports whether it has them, never their values.
// Phase 6 adds reconciliation and the order state machine.
import { ConfigError, loadBaseEnv, runWorker } from "@saarthi/core";
import { loadExchangeKeys, secretValues } from "./secrets.ts";

const keys = loadExchangeKeys();

runWorker(
  "executor",
  () => {
    const env = loadBaseEnv();
    if (env.tradingMode === "testnet" && !keys.binance) {
      throw new ConfigError(
        "TRADING_MODE=testnet needs BINANCE_API_KEY and BINANCE_API_SECRET in .env.local (see README).",
      );
    }
    return env;
  },
  ({ env }) => ({
    detail: () => `mode ${env.tradingMode}; binance keys ${keys.binance ? "loaded" : "not set"} (phase 6)`,
  }),
  secretValues(keys),
);
