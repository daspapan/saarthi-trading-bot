// The HTTP API. Kept separate from index.ts so tests can build the app
// without opening a real port. Later phases add signals, orders, the kill
// switch and the SSE stream.

import express, { type NextFunction, type Request, type Response } from "express";
import { Worker } from "node:worker_threads";
import {
  type BaseEnv,
  type Db,
  DISCLAIMER,
  STRATEGIES,
  STRATEGY_LABELS,
  TIMEFRAMES,
  type Timeframe,
  analystTokenPath,
  beat,
  createRunRecord,
  ensureAnalystToken,
  failStaleRuns,
  ingestAnalysis,
  listQueue,
  listSignalCards,
  loadSnapshot,
  requestAnalysis,
  tokensEqual,
  getRun,
  listRuns,
  listTables,
  loadSettingsFile,
  prepareBacktestRequest,
  readProcessStatus,
} from "@saarthi/core";
import { readCandleFiles, readCandles, readExchange, readFeeds, readPrices } from "./reads.ts";

const PAIR_PATTERN = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/;

/** The only writes the analyst's token may make (CFG-09). Everything else it tries gets a 403. */
const ANALYST_WRITES = new Set(["POST /signals", "POST /signals/heartbeat"]);

export function createApp(db: Db, env: BaseEnv, opts: { analystToken?: string } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" })); // a snapshot plus the model's raw answer

  const analystToken = opts.analystToken ?? ensureAnalystToken(analystTokenPath(env.dbPath));

  // Who is calling? The analyst proves itself with its token. It may read anything
  // and submit signals, nothing else. Nobody else may submit signals.
  app.use((req, res, next) => {
    const auth = req.get("authorization");
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;
    const isAnalyst = bearer !== null && tokensEqual(bearer, analystToken);
    if (bearer !== null && !isAnalyst) {
      res.status(401).json({ error: "Unknown token." });
      return;
    }
    const key = `${req.method} ${req.path}`;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isAnalyst && !isRead && !ANALYST_WRITES.has(key)) {
      res.status(403).json({ error: "The analyst token can only submit signals." });
      return;
    }
    if (!isAnalyst && ANALYST_WRITES.has(key)) {
      res.status(401).json({ error: "Only the analyst process can submit signals." });
      return;
    }
    next();
  });

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

  // ---------- AI analyst ----------

  app.post("/signals", (req, res) => {
    // Risk settings are read fresh each time, so an approved change applies at once.
    const result = ingestAnalysis(db, req.body, { risk: loadSettingsFile(env.configDir, "risk.json") });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.status(201).json(result);
  });

  app.post("/signals/heartbeat", (req, res) => {
    const detail = typeof req.body?.detail === "string" ? req.body.detail.slice(0, 300) : null;
    beat(db, "analyst", detail);
    res.json({ ok: true });
  });

  app.get("/signals", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 60) || 60));
    res.json({ signals: listSignalCards(db, limit) });
  });

  app.get("/queue", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
    res.json({ items: listQueue(db, limit) });
  });

  app.get("/snapshots/:hash", (req, res) => {
    const snap = /^[0-9a-f]{64}$/.test(req.params.hash) ? loadSnapshot(db, req.params.hash) : null;
    if (!snap) {
      res.status(404).json({ error: "No snapshot with that hash." });
      return;
    }
    res.json(snap);
  });

  // "Analyse now": queue a request; the analyst process picks it up within ~2 seconds.
  app.post("/analyse", (_req, res) => {
    const analyst = readProcessStatus(db).find((p) => p.name === "analyst");
    const requestId = requestAnalysis(db);
    res.status(202).json({
      requestId,
      analystRunning: analyst?.status === "up",
      message: analyst?.status === "up" ? "Analysis requested." : "Queued, but the analyst process is not running.",
    });
  });

  // ---------- settings (read-only here; editing with a PIN comes in phase 8) ----------

  app.get("/settings", (_req, res) => {
    res.json({
      strategy: loadSettingsFile(env.configDir, "strategy.json"),
      risk: loadSettingsFile(env.configDir, "risk.json"),
      strategies: STRATEGIES.map((id) => ({ id, label: STRATEGY_LABELS[id] })),
    });
  });

  // ---------- backtests ----------

  // Runs left "running" by a previous crash can never finish now.
  failStaleRuns(db);
  let runningId: number | null = null;

  app.get("/backtests/data", (_req, res) => {
    const pairs = loadSettingsFile(env.configDir, "strategy.json").pairs!.value as string[];
    res.json(readCandleFiles(env.candlesDir, pairs));
  });

  app.get("/backtests", (_req, res) => {
    res.json({ runs: listRuns(db) });
  });

  app.get("/backtests/:id", (req, res) => {
    const id = Number(req.params.id);
    const run = Number.isInteger(id) ? getRun(db, id) : null;
    if (!run) {
      res.status(404).json({ error: "No backtest with that ID." });
      return;
    }
    res.json(run);
  });

  app.post("/backtests", (req, res) => {
    if (runningId !== null) {
      res.status(409).json({ error: `Backtest #${runningId} is still running. Wait for it to finish.` });
      return;
    }
    const prepared = prepareBacktestRequest(req.body, env.configDir);
    if (!prepared.ok) {
      res.status(400).json({ error: prepared.error });
      return;
    }
    const id = createRunRecord(db, prepared.request);
    runningId = id;
    const worker = new Worker(new URL("./backtestWorker.ts", import.meta.url), {
      workerData: { dbPath: env.dbPath, runId: id, body: req.body, configDir: env.configDir, candlesDir: env.candlesDir },
    });
    const finish = () => {
      if (runningId === id) runningId = null;
    };
    worker.once("error", (err) => {
      db.prepare("UPDATE backtest_runs SET status = 'failed', error = ? WHERE id = ? AND status = 'running'").run(
        `The backtest crashed: ${err.message}`,
        id,
      );
      finish();
    });
    worker.once("exit", finish);
    res.status(202).json({ id, status: "running" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Plain-language errors only: never a stack trace or anything from the environment.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string }).type === "entity.parse.failed") {
      res.status(400).json({ error: "The request body is not valid JSON." });
      return;
    }
    res.status(500).json({ error: "Something went wrong on the server. Check the api logs." });
  });

  return app;
}
