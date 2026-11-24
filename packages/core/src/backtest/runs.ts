// Backtest runs as stored records: validate a request, run it, save it, read it back.
// The API runs executeBacktestRun() in a worker thread, so a two-year backtest
// never blocks the API (where the kill switch lives).

import { z } from "zod";
import { type SettingsFile, applySettingChange, loadSettingsFile } from "../config/settings.ts";
import { type Db, nowIso } from "../db/db.ts";
import { STRATEGIES } from "../strategies.ts";
import { loadBacktestCandles } from "./data.ts";
import { runBacktest, walkForward } from "./engine.ts";
import { DEFAULT_COSTS } from "./simExchange.ts";

export const backtestRequestSchema = z.strictObject({
  strategy: z.enum(["all", ...STRATEGIES]),
  from: z.number().int(),
  to: z.number().int(),
  slippageBps: z.number().min(0).max(50).default(DEFAULT_COSTS.slippageBps),
  overrides: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  label: z.string().trim().max(60).optional(),
});
export type BacktestRequest = z.infer<typeof backtestRequestSchema>;

export type PreparedRequest =
  | { ok: true; request: BacktestRequest; strategy: SettingsFile; risk: SettingsFile }
  | { ok: false; error: string };

/**
 * Checks a request and applies parameter overrides. Overrides must stay inside
 * each setting's approved range (same rule as the Strategy and Risk page).
 */
export function prepareBacktestRequest(body: unknown, configDir: string): PreparedRequest {
  const parsed = backtestRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    return { ok: false, error: `Invalid request: ${issue.path.join(".") || "body"}: ${issue.message}` };
  }
  const request = parsed.data;
  if (request.to <= request.from) return { ok: false, error: "The end date must be after the start date." };

  let strategy = loadSettingsFile(configDir, "strategy.json");
  let risk = loadSettingsFile(configDir, "risk.json");
  for (const [key, value] of Object.entries(request.overrides)) {
    if (key in strategy) {
      const r = applySettingChange(strategy, key, value);
      if (!r.ok) return { ok: false, error: r.reason };
      strategy = r.settings;
    } else if (key in risk) {
      const r = applySettingChange(risk, key, value);
      if (!r.ok) return { ok: false, error: r.reason };
      risk = r.settings;
    } else {
      return { ok: false, error: `Unknown setting "${key}".` };
    }
  }
  return { ok: true, request, strategy, risk };
}

/** Creates the run record (status "running") and returns its ID. */
export function createRunRecord(db: Db, request: BacktestRequest): number {
  const info = db
    .prepare(
      `INSERT INTO backtest_runs (strategy, params_json, start_ms, end_ms, status, label, created_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .run(request.strategy, JSON.stringify(request), request.from, request.to, request.label ?? null, nowIso());
  return Number(info.lastInsertRowid);
}

/** Runs the backtest and the walk-forward split, then saves everything. Never throws: failures are saved. */
export function executeBacktestRun(db: Db, runId: number, body: unknown, configDir: string, candlesDir: string): void {
  try {
    const prepared = prepareBacktestRequest(body, configDir);
    if (!prepared.ok) throw new Error(prepared.error);
    const { request, strategy, risk } = prepared;
    const pairs = strategy.pairs!.value as string[];
    const data = loadBacktestCandles(candlesDir, pairs);
    if (!data.range) throw new Error("No historical candles found. Run: npm run candles:download");
    const from = Math.max(request.from, data.range.from);
    const to = Math.min(request.to, data.range.to);
    if (to - from < 7 * 86_400_000) throw new Error("The chosen dates overlap less than 7 days of downloaded data.");

    const input = {
      pairs,
      candles15: data.candles15,
      candles4h: data.candles4h,
      from,
      to,
      strategy,
      risk,
      only: request.strategy,
      costs: { feeBps: DEFAULT_COSTS.feeBps, slippageBps: request.slippageBps },
    };
    const result = runBacktest(input);
    const wf = walkForward(input);

    db.exec("BEGIN");
    const insertTrade = db.prepare(
      `INSERT INTO backtest_trades (run_id, pair, entry_time_ms, exit_time_ms, entry_price, exit_price, quantity, fees, pnl, exit_reason, strategy, candidate_id, slippage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const t of result.trades) {
      insertTrade.run(runId, t.pair, t.entryTime, t.exitTime, t.entryPrice, t.exitPrice, t.quantity, t.fees, t.pnl, t.exitReason, t.strategy, t.candidateId, t.slippage);
    }
    db.prepare(
      `UPDATE backtest_runs SET status = 'done', start_ms = ?, end_ms = ?, metrics_json = ?, equity_curve_json = ?, result_json = ? WHERE id = ?`,
    ).run(
      from,
      to,
      JSON.stringify(result.metrics),
      JSON.stringify(result.curve),
      JSON.stringify({
        benchmark: result.benchmark,
        drawdown: result.drawdown,
        walkForward: wf,
        events: result.events,
        rejections: result.rejections,
        bars: result.bars,
        signalSource: result.signalSource,
        costs: input.costs,
        pairs,
      }),
      runId,
    );
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no transaction was open
    }
    db.prepare("UPDATE backtest_runs SET status = 'failed', error = ? WHERE id = ?").run((err as Error).message, runId);
  }
}

type RunRow = {
  id: number;
  strategy: string;
  params_json: string;
  start_ms: number;
  end_ms: number;
  status: string;
  error: string | null;
  label: string | null;
  metrics_json: string | null;
  equity_curve_json: string | null;
  result_json: string | null;
  created_at: string;
};

const parse = <T>(s: string | null): T | null => (s ? (JSON.parse(s) as T) : null);

export function listRuns(db: Db, limit = 50) {
  const rows = db.prepare("SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?").all(limit) as RunRow[];
  return rows.map((r) => {
    const m = parse<Record<string, number | null>>(r.metrics_json);
    const res = parse<{ benchmark: { totalReturn: number } }>(r.result_json);
    return {
      id: r.id,
      label: r.label,
      strategy: r.strategy,
      status: r.status,
      error: r.error,
      from: r.start_ms,
      to: r.end_ms,
      createdAt: r.created_at,
      summary: m
        ? {
            totalReturn: m.totalReturn,
            cagr: m.cagr,
            sharpe: m.sharpe,
            maxDrawdown: m.maxDrawdown,
            trades: m.trades,
            benchmarkReturn: res?.benchmark.totalReturn ?? null,
          }
        : null,
    };
  });
}

export function getRun(db: Db, id: number, tradeLimit = 500) {
  const r = db.prepare("SELECT * FROM backtest_runs WHERE id = ?").get(id) as RunRow | undefined;
  if (!r) return null;
  const trades = db
    .prepare(
      `SELECT pair, strategy, candidate_id AS candidateId, entry_time_ms AS entryTime, exit_time_ms AS exitTime,
              entry_price AS entryPrice, exit_price AS exitPrice, quantity, fees, slippage, pnl, exit_reason AS exitReason
       FROM backtest_trades WHERE run_id = ? ORDER BY entry_time_ms DESC LIMIT ?`,
    )
    .all(id, tradeLimit);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM backtest_trades WHERE run_id = ?").get(id) as { n: number }).n;
  return {
    id: r.id,
    label: r.label,
    strategy: r.strategy,
    status: r.status,
    error: r.error,
    from: r.start_ms,
    to: r.end_ms,
    createdAt: r.created_at,
    params: JSON.parse(r.params_json),
    metrics: parse(r.metrics_json),
    curve: parse(r.equity_curve_json),
    ...(parse<Record<string, unknown>>(r.result_json) ?? {}),
    trades,
    totalTrades: total,
  };
}

/** A run left "running" by a crash or restart is marked failed, so the UI isn't stuck waiting. */
export function failStaleRuns(db: Db): number {
  const info = db
    .prepare("UPDATE backtest_runs SET status = 'failed', error = 'The API restarted while this run was in progress.' WHERE status = 'running'")
    .run();
  return Number(info.changes);
}
