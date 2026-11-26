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
  SESSION_COOKIE,
  applySettingsChanges,
  clientAddress,
  createSession,
  ensureSessionSecret,
  isLoopback,
  listAudit,
  previewChanges,
  readCookie,
  readPerformance,
  sessionSecretPath,
  settingsHistory,
  verifyChain,
  verifySession,
  NEEDS_RESTART,
  appendAudit,
  latestAlertId,
  listAlerts,
  readRiskView,
  restartTrading,
  triggerLiquidation,
  verifyPin,
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
import { readOrders, readPositions, readTrades } from "./trading.ts";
import { readCandleFiles, readCandles, readExchange, readFeeds, readPrices } from "./reads.ts";

const PAIR_PATTERN = /^[A-Z0-9]{2,10}\/[A-Z0-9]{2,10}$/;

/** The only writes the analyst's token may make (CFG-09). Everything else it tries gets a 403. */
const ANALYST_WRITES = new Set(["POST /signals", "POST /signals/heartbeat"]);

export function createApp(db: Db, env: BaseEnv, opts: { analystToken?: string; sessionSecret?: string } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" })); // a snapshot plus the model's raw answer

  const analystToken = opts.analystToken ?? ensureAnalystToken(analystTokenPath(env.dbPath));
  const sessionSecret = opts.sessionSecret ?? ensureSessionSecret(sessionSecretPath(env.dbPath));

  // Wrong PINs: at most 5 per minute, then a short lockout. Every wrong PIN is audited (RISK-08).
  const pinFailures: number[] = [];
  const pinLocked = () => {
    const cutoff = Date.now() - 60_000;
    while (pinFailures.length && pinFailures[0]! < cutoff) pinFailures.shift();
    return pinFailures.length >= 5;
  };

  // Phone access (ALLOW_LAN): anyone not on this computer must unlock with the PIN first.
  // The web app's LAN gateway tells us the caller's real address (see clientAddress).
  const isLocal = (req: Request) => isLoopback(clientAddress(req.socket.remoteAddress, req.headers["x-saarthi-client"]));
  const unlocked = (req: Request) => isLocal(req) || verifySession(sessionSecret, readCookie(req.headers.cookie, SESSION_COOKIE));
  app.use((req, res, next) => {
    if (req.path === "/session" || unlocked(req)) return next();
    res.status(401).json({ error: "Locked. Enter the PIN to use the dashboard from this device.", locked: true });
  });

  app.get("/session", (req, res) => {
    res.json({ local: isLocal(req), unlocked: unlocked(req), pinRequired: env.pinHash !== null, lanEnabled: env.allowLan });
  });

  app.post("/session", (req, res) => {
    if (!env.pinHash) {
      res.status(409).json({ error: "No PIN is set on this computer, so phone access is off." });
      return;
    }
    if (pinLocked()) {
      res.status(429).json({ error: "Too many wrong PINs. Wait a minute." });
      return;
    }
    const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
    if (!verifyPin(pin, env.pinHash)) {
      pinFailures.push(Date.now());
      appendAudit(db, "pin_rejected", "operator", { action: "unlock", client: clientAddress(req.socket.remoteAddress, req.headers["x-saarthi-client"]) });
      res.status(403).json({ error: "Wrong PIN." });
      return;
    }
    const s = createSession(sessionSecret);
    appendAudit(db, "session_unlocked", "operator", { client: clientAddress(req.socket.remoteAddress, req.headers["x-saarthi-client"]) });
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${s.value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((s.expMs - Date.now()) / 1000)}`);
    res.json({ ok: true, expiresAt: new Date(s.expMs).toISOString() });
  });

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

  app.get("/orders", (req, res) => {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 30) || 30));
    res.json(readOrders(db, limit));
  });

  app.get("/positions", (_req, res) => {
    res.json({ positions: readPositions(db) });
  });

  app.get("/trades", (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 50) || 50));
    res.json(readTrades(db, limit));
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

  app.post("/settings/preview", (req, res) => {
    const file = req.body?.file;
    if (file !== "strategy.json" && file !== "risk.json") {
      res.status(400).json({ error: "file must be strategy.json or risk.json." });
      return;
    }
    const changes = req.body?.changes && typeof req.body.changes === "object" ? req.body.changes : {};
    res.json({ lines: previewChanges(loadSettingsFile(env.configDir, file), changes), pinRequired: env.pinHash !== null });
  });

  app.post("/settings", (req, res) => {
    if (pinLocked()) {
      res.status(429).json({ error: "Too many wrong PINs. Wait a minute." });
      return;
    }
    const r = applySettingsChanges(db, { configDir: env.configDir, file: req.body?.file, changes: req.body?.changes, pin: req.body?.pin, pinHash: env.pinHash, actor: "operator" });
    if (!r.ok) {
      if (r.status === 403) pinFailures.push(Date.now());
      res.status(r.status).json({ error: r.error, lines: r.lines });
      return;
    }
    const restart = r.applied.filter((l) => l.restart);
    res.json({
      ok: true,
      applied: r.applied,
      message: `Saved ${r.applied.length} change${r.applied.length === 1 ? "" : "s"}.${restart.length ? ` Restart npm run dev for ${restart.map((l) => l.key).join(", ")} to take effect.` : " They take effect on the next check."}`,
    });
  });

  app.get("/settings/history", (_req, res) => {
    res.json({ history: settingsHistory(db), needsRestart: NEEDS_RESTART });
  });

  // ---------- audit and performance (phase 8) ----------

  app.get("/audit", (req, res) => {
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const before = Number(req.query.before);
    res.json(listAudit(db, { type: str(req.query.type), actor: str(req.query.actor), q: str(req.query.q), before: Number.isInteger(before) && before > 0 ? before : undefined, limit: Number(req.query.limit) || 100 }));
  });

  app.get("/audit/verify", (_req, res) => {
    const started = Date.now();
    res.json({ ...verifyChain(db), ms: Date.now() - started });
  });

  app.get("/performance", (_req, res) => {
    res.json(readPerformance(db));
  });

  // ---------- risk, kill switch, alerts (phase 7) ----------

  app.get("/risk", (_req, res) => {
    const view = readRiskView(db, loadSettingsFile(env.configDir, "risk.json"));
    res.json({ ...view, pinRequired: env.pinHash !== null });
  });

  app.post("/kill", (req, res) => {
    const pin = typeof req.body?.pin === "string" ? req.body.pin : undefined;
    if (env.pinHash) {
      if (pinLocked()) {
        res.status(429).json({ error: "Too many wrong PINs. Wait a minute, or run `npm run kill -- <PIN>` in a terminal." });
        return;
      }
      if (!pin || !verifyPin(pin, env.pinHash)) {
        pinFailures.push(Date.now());
        appendAudit(db, "pin_rejected", "operator", { action: "kill", ip: req.ip });
        res.status(403).json({ error: "Wrong PIN. Nothing was changed." });
        return;
      }
    }
    const r = triggerLiquidation(db, { source: "kill-switch", reason: "Pressed on the dashboard.", actor: "operator" });
    res.status(202).json({
      ...r,
      message: r.alreadyActive ? "Already closing everything." : "Kill switch on. Every order is being cancelled and every position sold.",
    });
  });

  app.post("/restart", (req, res) => {
    if (pinLocked()) {
      res.status(429).json({ error: "Too many wrong PINs. Wait a minute." });
      return;
    }
    const pin = typeof req.body?.pin === "string" ? req.body.pin : undefined;
    const r = restartTrading(db, pin, env.pinHash, "operator");
    if (!r.ok) {
      if (r.status === 403) pinFailures.push(Date.now());
      res.status(r.status).json({ error: r.error });
      return;
    }
    res.json({ ok: true, message: "Trading restarted." });
  });

  app.get("/alerts", (req, res) => {
    const after = req.query.after === undefined ? undefined : Number(req.query.after);
    const limit = Number(req.query.limit ?? 50) || 50;
    res.json({ latestId: latestAlertId(db), alerts: listAlerts(db, { afterId: Number.isFinite(after) ? after : undefined, limit }) });
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
