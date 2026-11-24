// Executor process: the only process that holds exchange keys and the only one that trades.
//
// On start it reconciles with the exchange, then every second it:
//   1. lets the paper exchange match orders (paper mode only)
//   2. moves each order one step through the state machine
// and every 10 seconds records equity from real balances (the risk monitor reads it).

import { Executor, PaperExchange, loadBaseEnv, loadSettingsFile, reconcile, recordEquity, runWorker } from "@saarthi/core";
import { createExchangeClient, priceFromDb } from "./client.ts";
import { loadExchangeKeys, secretValues } from "./secrets.ts";

const TICK_MS = 1_000;
const EQUITY_EVERY_MS = 10_000; // the risk monitor checks the daily loss and drawdown against this

const keys = loadExchangeKeys();

runWorker(
  "executor",
  () => loadBaseEnv(),
  ({ env, db, log }) => {
    const client = createExchangeClient(env.tradingMode, { db, keys });
    if (!client) return { detail: () => "backtest mode: no live orders" };

    const strategy = loadSettingsFile(env.configDir, "strategy.json");
    const pairs = strategy.pairs!.value as string[];
    const executor = new Executor({ db, client, risk: () => loadSettingsFile(env.configDir, "risk.json"), log });
    const price = priceFromDb(db);

    let ready = false;
    let busy = false;
    let lastEquity = 0;
    let lastError: string | null = null;

    const start = async () => {
      // Never trade on a stale picture: reconcile first, and retry until it works.
      for (;;) {
        try {
          const r = await reconcile(db, client, Date.now());
          log.info(r, "reconciled with the exchange");
          ready = true;
          return;
        } catch (err) {
          lastError = (err as Error).message;
          log.warn({ err: lastError }, "reconciliation failed, retrying in 5 s");
          await new Promise((res) => setTimeout(res, 5_000));
        }
      }
    };

    const loop = async () => {
      if (!ready || busy) return;
      busy = true;
      try {
        if (client instanceof PaperExchange) client.process();
        await executor.tick();
        const prices = Object.fromEntries(pairs.map((p) => [p, price(p)]));
        // Without a price for every pair the equity would be understated, so wait for the feed.
        if (Date.now() - lastEquity >= EQUITY_EVERY_MS && Object.values(prices).every((p) => p !== null)) {
          await recordEquity(db, client, pairs, prices as Record<string, number>, Date.now());
          lastEquity = Date.now();
        }
        lastError = null;
      } catch (err) {
        lastError = (err as Error).message;
        log.error({ err: lastError }, "executor tick failed");
      } finally {
        busy = false;
      }
    };

    void start();
    const timer = setInterval(() => void loop(), TICK_MS);
    return {
      detail: () => {
        if (!ready) return `${client.name}: reconciling${lastError ? ` (${lastError})` : ""}`;
        const active = (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE state NOT IN ('CLOSED','CANCELLED','FAILED')").get() as { n: number }).n;
        return `${client.name}; ${active} active order${active === 1 ? "" : "s"}${lastError ? `; last error: ${lastError}` : ""}`;
      },
      stop: () => clearInterval(timer),
    };
  },
  secretValues(keys),
);
