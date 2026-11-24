// Tiny shared bootstrap for the four worker processes: load config (which runs
// the testnet guard), open the DB, start the heartbeat, shut down cleanly.

import { type BaseEnv, ConfigError } from "./config/env.ts";
import { type Db, migrate, openDb } from "./db/db.ts";
import { type ProcessName, startHeartbeat } from "./heartbeat.ts";
import { createLogger } from "./logger.ts";
import type { Logger } from "pino";

export type WorkerContext = { env: BaseEnv; db: Db; log: Logger };

export function runWorker(
  name: ProcessName,
  loadEnv: () => BaseEnv,
  start: (ctx: WorkerContext) => { detail: () => string | null; stop?: () => void },
  logSecrets: readonly string[] = [],
): void {
  const log = createLogger(name, { level: process.env.LOG_LEVEL, secrets: logSecrets });
  try {
    const env = loadEnv();
    const db = openDb(env.dbPath);
    migrate(db);
    const worker = start({ env, db, log });
    const stopBeat = startHeartbeat(db, name, worker.detail);
    log.info({ mode: env.tradingMode }, `${name} started`);

    const shutdown = () => {
      stopBeat();
      worker.stop?.();
      db.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    log.fatal(err instanceof ConfigError ? err.message : err);
    process.exit(1);
  }
}
