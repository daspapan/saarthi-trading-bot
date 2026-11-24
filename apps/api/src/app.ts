// The HTTP API. Kept separate from index.ts so tests can build the app
// without opening a real port. Later phases add signals, orders, the kill
// switch and the SSE stream.

import express, { type NextFunction, type Request, type Response } from "express";
import { type BaseEnv, type Db, DISCLAIMER, TIMEFRAMES, type Timeframe, listTables, readProcessStatus } from "@saarthi/core";
import { readCandles, readExchange, readFeeds, readPrices } from "./reads.ts";

const PAIR_PATTERN = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/;

export function createApp(db: Db, env: BaseEnv) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.get("/health", (_req, res) => {
    let dbStatus: "ok" | "error" = "ok";
    try {
      listTables(db);
    } catch {
      dbStatus = "error";
    }
    const ok = dbStatus === "ok";
    res.json({
      ok,
      mode: env.tradingMode,
      testnetOnly: true,
      time: new Date().toISOString(),
      db: dbStatus,
      processes: ok ? readProcessStatus(db) : [],
      feeds: ok ? readFeeds(db) : null,
      exchange: ok ? readExchange(db) : null,
      disclaimer: DISCLAIMER,
    });
  });

  app.get("/prices", (_req, res) => {
    res.json({ prices: readPrices(db) });
  });

  app.get("/candles", (req, res) => {
    const pair = String(req.query.pair ?? "");
    const timeframe = String(req.query.tf ?? "15m");
    const limit = Number(req.query.limit ?? 200);
    if (!PAIR_PATTERN.test(pair)) {
      res.status(400).json({ error: 'Give a pair like "BTC/USDT" in ?pair=.' });
      return;
    }
    if (!(timeframe in TIMEFRAMES)) {
      res.status(400).json({ error: `Timeframe must be one of: ${Object.keys(TIMEFRAMES).join(", ")}.` });
      return;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({ error: "limit must be a whole number from 1 to 1000." });
      return;
    }
    res.json({ pair, timeframe, candles: readCandles(db, pair, timeframe as Timeframe, limit) });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Plain-language errors only: never a stack trace or anything from the environment.
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "Something went wrong on the server. Check the api logs." });
  });

  return app;
}
