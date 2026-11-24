// API process entry point.
import {
  ConfigError,
  createLogger,
  loadBaseEnv,
  migrate,
  openDb,
  resolveBindHost,
  startHeartbeat,
} from "@saarthi/core";
import { createApp } from "./app.ts";

const log = createLogger("api", { level: process.env.LOG_LEVEL });

try {
  const env = loadBaseEnv();
  const host = resolveBindHost(env);
  const db = openDb(env.dbPath);
  migrate(db);

  const app = createApp(db, env);
  const server = app.listen(env.apiPort, host, () => {
    log.info({ host, port: env.apiPort, mode: env.tradingMode }, `API listening on http://${host}:${env.apiPort}`);
  });
  const stopBeat = startHeartbeat(db, "api", () => `http://${host}:${env.apiPort}`);

  const shutdown = () => {
    stopBeat();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (err) {
  // A config problem is a clear one-line message, not a stack trace.
  log.fatal(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
