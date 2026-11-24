// Analyst process: the AI side. It has NO exchange keys (loadAnalystEnv refuses
// to start if any are visible), opens the database READ-ONLY, and its only way to
// affect anything is POST /signals with a token the API scopes to exactly that.
//
// Every ANALYSIS_INTERVAL_MIN minutes, and on "Analyse now", it builds a snapshot,
// asks Ollama, and hands the answer to the API, which runs the guardrails.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  Analyst,
  ConfigError,
  analystTokenPath,
  buildSnapshot,
  createLogger,
  latestAnalysisRequest,
  loadAnalystEnv,
  loadSettingsFile,
  ollamaChat,
  ollamaStatus,
  openDb,
  readAnalystToken,
  readFeedTrust,
  readSnapshotInputs,
  startAnalystSchedule,
} from "@saarthi/core";

const log = createLogger("analyst", { level: process.env.LOG_LEVEL });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

async function main() {
  const env = loadAnalystEnv();
  const apiUrl = `http://127.0.0.1:${env.apiPort}`;

  // The API creates the database and the token; wait for both.
  let token: string | null = null;
  for (let waited = 0; !(existsSync(env.dbPath) && (token = readAnalystToken(analystTokenPath(env.dbPath)))); waited++) {
    if (waited === 0) log.info("Waiting for the API to create the database and the analyst token...");
    await sleep(2_000);
  }
  const db = openDb(env.dbPath, { readOnly: true });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(apiUrl + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; signals?: { pair: string; direction: string; passed: boolean }[] };
    if (!res.ok) throw new Error(json.error ?? `API answered HTTP ${res.status}`);
    return json;
  };

  const headlinesPath = join(dirname(env.dbPath), "headlines.txt");
  const analyst = new Analyst({
    model: env.ollamaModel,
    trust: () => readFeedTrust(db),
    buildSnapshot: () =>
      buildSnapshot(
        readSnapshotInputs(db, {
          nowMs: Date.now(),
          mode: env.tradingMode,
          // Read fresh each run, so approved setting changes apply immediately.
          strategy: loadSettingsFile(env.configDir, "strategy.json"),
          risk: loadSettingsFile(env.configDir, "risk.json"),
        }),
      ),
    chat: ollamaChat({ url: env.ollamaUrl, model: env.ollamaModel }),
    headlines: () => (existsSync(headlinesPath) ? readFileSync(headlinesPath, "utf8").split("\n").filter((l) => l.trim()) : []),
    submit: async (s) => {
      const result = await post("/signals", s);
      const summary = (result.signals ?? []).map((x) => `${x.pair} ${x.direction}${x.passed ? "" : " (rejected)"}`).join(", ");
      log.info({ source: s.source, latencyMs: s.latencyMs }, `Analysis ${s.trigger}: ${s.note ?? summary}`);
      return result;
    },
    log,
  });

  const intervalMs = env.analysisIntervalMin * 60_000;
  let nextRun = Date.now() + intervalMs;
  const stopSchedule = startAnalystSchedule({
    analyst,
    intervalMs,
    latestRequest: () => latestAnalysisRequest(db),
    onError: (err) => log.error({ err: (err as Error).message }, "Analysis failed."),
  });
  setInterval(() => (nextRun = Date.now() + intervalMs), intervalMs);

  // Ollama health (for the health strip) every 30 s.
  let ollama = await ollamaStatus(env.ollamaUrl, env.ollamaModel);
  setInterval(async () => (ollama = await ollamaStatus(env.ollamaUrl, env.ollamaModel)), 30_000);

  // Heartbeat through the API (the analyst can't write to the database).
  const heartbeat = async () => {
    const last = analyst.lastRun ? `last run ${hhmm(analyst.lastRun.at)} (${analyst.lastRun.source})` : "no run yet";
    const detail = `${ollama.detail} · ${analyst.isRunning ? "analysing now…" : last} · next ${hhmm(nextRun)}`;
    await post("/signals/heartbeat", { detail }).catch((err) => log.warn({ err: (err as Error).message }, "Heartbeat failed."));
  };
  await heartbeat();
  setInterval(heartbeat, 5_000);

  log.info(`Analyst started: ${env.ollamaModel}, every ${env.analysisIntervalMin} min. No exchange keys, read-only database.`);
  const shutdown = () => {
    stopSchedule();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.fatal(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
