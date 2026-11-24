// Runs one backtest in a worker thread so the API (and its kill switch) stays responsive.
import { parentPort, workerData } from "node:worker_threads";
import { executeBacktestRun, openDb } from "@saarthi/core";

const { dbPath, runId, body, configDir, candlesDir } = workerData as {
  dbPath: string;
  runId: number;
  body: unknown;
  configDir: string;
  candlesDir: string;
};

const db = openDb(dbPath);
executeBacktestRun(db, runId, body, configDir, candlesDir);
db.close();
parentPort?.postMessage({ runId, done: true });
