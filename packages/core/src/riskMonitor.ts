// The risk monitor (the "risk" process runs it every 5 seconds).
//
//   Daily loss: today's P&L = equity now - equity at the start of the UTC day. Because
//   equity is cash plus coins at the current price, this includes realised P&L,
//   unrealised P&L and every fee paid (RISK-01). Warn at 80% of the limit (RISK-02);
//   at 100% set daily_limit_hit, which the validator checks, for the rest of the UTC
//   day (RISK-03, RISK-04).
//
//   Drawdown: how far equity is below its high-water mark (RISK-05). At the limit:
//   the same as the kill switch, plus manual restart (RISK-06).
//
//   Health: an alarm when the executor or the feed stops reporting.

import { raiseAlert } from "./alerts.ts";
import { appendAudit } from "./audit.ts";
import { type SettingsFile, num } from "./config/settings.ts";
import type { Db } from "./db/db.ts";
import { getRiskFlag, setRiskFlag } from "./feed/store.ts";
import { readProcessStatus } from "./heartbeat.ts";
import { activeOrderCount, triggerLiquidation } from "./killSwitch.ts";
import { discardPending } from "./queue.ts";
import { exposureOf } from "./risk.ts";

const DAY = 86_400_000;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type RiskLimitsView = { dailyLossLimitBps: number; dailyLossWarnPct: number; maxDrawdownBps: number; maxExposureBps: number; maxAssetBps: number };

export function riskViewLimits(risk: SettingsFile): RiskLimitsView {
  return {
    dailyLossLimitBps: num(risk, "dailyLossLimitBps"),
    dailyLossWarnPct: num(risk, "dailyLossWarnPct"),
    maxDrawdownBps: num(risk, "maxDrawdownBps"),
    maxExposureBps: num(risk, "maxExposureBps"),
    maxAssetBps: num(risk, "maxAssetBps"),
  };
}

export type RiskAssessment = {
  dailyPnl: number;
  dailyPnlPct: number;
  dailyLossLimit: number;
  /** Share of the daily loss limit used: 0 when flat or up, 100 at the limit. */
  dailyUsedPct: number;
  warn: boolean;
  limitHit: boolean;
  drawdownPct: number;
  drawdownLimitPct: number;
  drawdownHit: boolean;
};

/** Pure maths for the two limits. */
export function assessRisk(x: { equity: number; dayStartEquity: number; highWaterMark: number }, l: RiskLimitsView): RiskAssessment {
  const dailyPnl = x.equity - x.dayStartEquity;
  const dailyLossLimit = (x.dayStartEquity * l.dailyLossLimitBps) / 10_000;
  const dailyUsedPct = dailyPnl >= 0 || dailyLossLimit <= 0 ? 0 : (-dailyPnl / dailyLossLimit) * 100;
  const drawdownPct = x.highWaterMark > 0 ? Math.max(0, ((x.highWaterMark - x.equity) / x.highWaterMark) * 100) : 0;
  const drawdownLimitPct = l.maxDrawdownBps / 100;
  return {
    dailyPnl,
    dailyPnlPct: x.dayStartEquity > 0 ? (dailyPnl / x.dayStartEquity) * 100 : 0,
    dailyLossLimit,
    dailyUsedPct,
    warn: dailyUsedPct >= l.dailyLossWarnPct,
    limitHit: dailyUsedPct >= 100 - 1e-9,
    drawdownPct,
    drawdownLimitPct,
    drawdownHit: drawdownPct >= drawdownLimitPct - 1e-9,
  };
}

export type RiskView = {
  equity: number | null;
  cash: number | null;
  dayStartEquity: number | null;
  highWaterMark: number | null;
  equityAt: string | null;
  equityAgeSec: number | null;
  assessment: RiskAssessment | null;
  breakdown: { realisedToday: number; unrealised: number; feesToday: number };
  exposure: { total: number; pct: number; limitPct: number; byPair: { pair: string; value: number; pct: number; limitPct: number }[] };
  limits: RiskLimitsView;
  flags: {
    killSwitch: { active: boolean; reason: string | null };
    manualRestart: { active: boolean; reason: string | null };
    dailyLimitHit: { active: boolean; reason: string | null };
    liquidating: { active: boolean; since: string | null; ordersLeft: number };
  };
};

/** Everything the Cockpit shows about risk. Read-only. */
export function readRiskView(db: Db, risk: SettingsFile, nowMs = Date.now()): RiskView {
  const limits = riskViewLimits(risk);
  const eq = db.prepare("SELECT equity, cash, high_water_mark, day_start_equity, created_at FROM equity_snapshots ORDER BY id DESC LIMIT 1").get() as
    | { equity: number; cash: number; high_water_mark: number; day_start_equity: number; created_at: string }
    | undefined;
  const today = new Date(Math.floor(nowMs / DAY) * DAY).toISOString();

  const positions = db
    .prepare("SELECT p.pair, p.quantity, p.avg_entry, p.fees_paid, ps.last FROM positions p LEFT JOIN price_state ps ON ps.pair = p.pair WHERE p.status = 'open'")
    .all() as { pair: string; quantity: number; avg_entry: number; fees_paid: number; last: number | null }[];
  const prices: Record<string, number> = {};
  for (const p of positions) if (p.last !== null) prices[p.pair] = p.last;
  const unrealised = positions.reduce((s, p) => s + (p.last === null ? 0 : (p.last - p.avg_entry) * p.quantity - p.fees_paid), 0);
  const realisedToday = (db.prepare("SELECT COALESCE(SUM(realised_pnl), 0) AS v FROM positions WHERE status = 'closed' AND closed_at >= ?").get(today) as { v: number }).v;
  const feesToday =
    (db.prepare("SELECT COALESCE(SUM(entry_fee), 0) AS v FROM orders WHERE filled_quantity > 0 AND created_at >= ?").get(today) as { v: number }).v +
    (db.prepare("SELECT COALESCE(SUM(exit_fee), 0) AS v FROM orders WHERE state = 'CLOSED' AND exit_fee IS NOT NULL AND state_since >= ?").get(today) as { v: number }).v;

  const equity = eq?.equity ?? null;
  const exp = exposureOf({ equity: equity ?? 0, cash: eq?.cash ?? 0, positions: positions.map((p) => ({ pair: p.pair, quantity: p.quantity, avgEntry: p.avg_entry })) }, prices);
  const pctOf = (v: number) => (equity && equity > 0 ? (v / equity) * 100 : 0);
  const liquidate = getRiskFlag(db, "liquidate");
  const liqSince = liquidate.active
    ? ((db.prepare("SELECT updated_at FROM risk_flags WHERE name = 'liquidate'").get() as { updated_at: string } | undefined)?.updated_at ?? null)
    : null;

  return {
    equity,
    cash: eq?.cash ?? null,
    dayStartEquity: eq?.day_start_equity ?? null,
    highWaterMark: eq?.high_water_mark ?? null,
    equityAt: eq?.created_at ?? null,
    equityAgeSec: eq ? Math.max(0, Math.round((nowMs - Date.parse(eq.created_at)) / 1000)) : null,
    assessment: eq ? assessRisk({ equity: eq.equity, dayStartEquity: eq.day_start_equity, highWaterMark: eq.high_water_mark }, limits) : null,
    breakdown: { realisedToday, unrealised, feesToday },
    exposure: {
      total: exp.total,
      pct: pctOf(exp.total),
      limitPct: limits.maxExposureBps / 100,
      byPair: Object.entries(exp.byPair).map(([pair, value]) => ({ pair, value, pct: pctOf(value), limitPct: limits.maxAssetBps / 100 })),
    },
    limits,
    flags: {
      killSwitch: getRiskFlag(db, "kill_switch"),
      manualRestart: getRiskFlag(db, "manual_restart"),
      dailyLimitHit: getRiskFlag(db, "daily_limit_hit"),
      liquidating: { active: liquidate.active, since: liqSince, ordersLeft: liquidate.active ? activeOrderCount(db) : 0 },
    },
  };
}

/** Executor and feed are the processes whose silence matters for trading. */
const WATCHED = ["executor", "feed"] as const;

export class RiskMonitor {
  private db: Db;
  private risk: () => SettingsFile;

  constructor(db: Db, risk: () => SettingsFile) {
    this.db = db;
    this.risk = risk;
  }

  /** One check. Returns the view it acted on (handy for the heartbeat detail and tests). */
  tick(nowMs = Date.now()): RiskView {
    const db = this.db;
    const day = dayKey(nowMs);

    // RISK-04: the daily limit lasts until UTC midnight, then trading may resume.
    const daily = getRiskFlag(db, "daily_limit_hit");
    if (daily.active && !(daily.reason ?? "").startsWith(`[${day}]`)) {
      setRiskFlag(db, "daily_limit_hit", false, null, nowMs);
      appendAudit(db, "risk", "risk", { event: "daily_limit_reset", day });
      raiseAlert(db, { level: "info", kind: "daily_limit_reset", message: "New UTC day: the daily loss limit has reset. New orders are allowed again.", key: `daily_reset:${day}`, actor: "risk" }, nowMs);
    }

    const view = readRiskView(db, this.risk(), nowMs);
    const a = view.assessment;
    // Only act on a fresh equity figure from today (the executor writes one every 10 s).
    const fresh = a && view.equityAt !== null && view.equityAt.slice(0, 10) === day;
    if (a && fresh) {
      if (a.warn && !a.limitHit) {
        raiseAlert(db, { level: "warn", kind: "daily_loss_warning", message: `Today's loss is ${(-a.dailyPnl).toFixed(2)} USDT: ${a.dailyUsedPct.toFixed(0)}% of the daily limit (${a.dailyLossLimit.toFixed(2)} USDT).`, key: `daily_warn:${day}`, actor: "risk" }, nowMs);
      }
      if (a.limitHit && !getRiskFlag(db, "daily_limit_hit").active) {
        const reason = `[${day}] Lost ${(-a.dailyPnl).toFixed(2)} USDT today, the daily limit of ${a.dailyLossLimit.toFixed(2)} USDT.`;
        setRiskFlag(db, "daily_limit_hit", true, reason, nowMs);
        discardPending(db, "Daily loss limit hit: no new orders until UTC midnight.");
        appendAudit(db, "risk", "risk", { event: "daily_limit_hit", day, dailyPnl: a.dailyPnl, limit: a.dailyLossLimit });
        raiseAlert(db, { level: "critical", kind: "daily_limit_hit", message: `Daily loss limit hit (${(-a.dailyPnl).toFixed(2)} USDT). No new orders until 00:00 UTC. Open positions keep their stops.`, key: `daily_limit:${day}`, actor: "risk" }, nowMs);
      }
      if (a.drawdownHit && !getRiskFlag(db, "manual_restart").active) {
        triggerLiquidation(
          db,
          { source: "drawdown", reason: `Equity ${view.equity!.toFixed(2)} is ${a.drawdownPct.toFixed(1)}% below its high of ${view.highWaterMark!.toFixed(2)} (limit ${a.drawdownLimitPct}%).`, actor: "risk" },
          nowMs,
        );
      }
    }

    // Health alarm: one per outage (the key holds the last heartbeat, which stays fixed while it's down).
    const beats = new Map((db.prepare("SELECT name, last_beat_at FROM process_heartbeats").all() as { name: string; last_beat_at: string }[]).map((r) => [r.name, r.last_beat_at]));
    for (const p of readProcessStatus(db, nowMs)) {
      if (!(WATCHED as readonly string[]).includes(p.name) || p.status !== "down") continue;
      const holdsPositions = p.name === "executor" && activeOrderCount(db) > 0;
      raiseAlert(
        db,
        {
          level: holdsPositions ? "critical" : "warn",
          kind: "health",
          message: `The ${p.name} process stopped reporting ${p.lastBeatAgoSec} s ago.${holdsPositions ? " Open positions still have their stops on the exchange, but nothing new is being managed." : ""}`,
          key: `health:${p.name}:${beats.get(p.name)}`,
          actor: "risk",
        },
        nowMs,
      );
    }
    return view;
  }
}
