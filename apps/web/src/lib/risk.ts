// Types and pure helpers for the Cockpit (unit-tested, no React here).

export type RiskAssessment = {
  dailyPnl: number;
  dailyPnlPct: number;
  dailyLossLimit: number;
  dailyUsedPct: number;
  warn: boolean;
  limitHit: boolean;
  drawdownPct: number;
  drawdownLimitPct: number;
  drawdownHit: boolean;
};

type Flag = { active: boolean; reason: string | null };

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
  limits: { dailyLossLimitBps: number; dailyLossWarnPct: number; maxDrawdownBps: number; maxExposureBps: number; maxAssetBps: number };
  flags: { killSwitch: Flag; manualRestart: Flag; dailyLimitHit: Flag; liquidating: { active: boolean; since: string | null; ordersLeft: number } };
  pinRequired: boolean;
};

export type Alert = { id: number; level: "info" | "warn" | "critical"; kind: string; message: string; orderId: number | null; createdAt: string };

export type GaugeLevel = "ok" | "warning" | "limit";

/** A gauge's level and the word shown beside it (colour is never the only signal). */
export function gaugeLevel(usedPctOfLimit: number, warnAt = 80): { level: GaugeLevel; word: string } {
  if (usedPctOfLimit >= 100) return { level: "limit", word: "LIMIT" };
  if (usedPctOfLimit >= warnAt) return { level: "warning", word: "WARNING" };
  return { level: "ok", word: "OK" };
}

export type Gauge = { key: string; label: string; value: string; detail: string; usedPct: number; level: GaugeLevel; word: string; help: string };

/** The three Cockpit gauges, each as a share of its own limit. */
export function gaugesFor(v: RiskView): Gauge[] {
  const a = v.assessment;
  const daily = a?.dailyUsedPct ?? 0;
  const dd = a ? (a.drawdownPct / a.drawdownLimitPct) * 100 : 0;
  const ex = v.exposure.limitPct > 0 ? (v.exposure.pct / v.exposure.limitPct) * 100 : 0;
  const lossToday = a ? Math.max(0, -a.dailyPnl) : 0;
  return [
    {
      key: "daily",
      label: "Daily loss used",
      value: `${Math.round(daily)}%`,
      detail: a ? `${lossToday.toFixed(2)} of ${a.dailyLossLimit.toFixed(2)} USDT` : "no equity yet",
      usedPct: daily,
      ...gaugeLevel(daily, v.limits.dailyLossWarnPct),
      help: `If today's loss reaches ${v.limits.dailyLossLimitBps / 100}% of the equity at 00:00 UTC, no new orders until the next UTC day.`,
    },
    {
      key: "drawdown",
      label: "Drawdown",
      value: `${(a?.drawdownPct ?? 0).toFixed(1)}%`,
      detail: `limit ${v.limits.maxDrawdownBps / 100}% below the high of ${v.highWaterMark?.toFixed(2) ?? "n/a"}`,
      usedPct: dd,
      ...gaugeLevel(dd),
      help: "How far equity is below its highest point. At the limit everything is sold and a PIN restart is needed.",
    },
    {
      key: "exposure",
      label: "Exposure",
      value: `${v.exposure.pct.toFixed(0)}%`,
      detail: `${v.exposure.total.toFixed(2)} USDT in coins, limit ${v.exposure.limitPct}%`,
      usedPct: ex,
      ...gaugeLevel(ex, 90),
      help: "Value of all open positions as a share of equity. The validator refuses orders that would go over the limit.",
    },
  ];
}

export type TradingState =
  | { kind: "trading" }
  | { kind: "daily-stop"; reason: string }
  | { kind: "liquidating"; ordersLeft: number; sinceSec: number }
  | { kind: "stopped"; reason: string };

/** What the kill-switch panel should show. */
export function tradingState(v: RiskView, nowMs = Date.now()): TradingState {
  const f = v.flags;
  if (f.liquidating.active) return { kind: "liquidating", ordersLeft: f.liquidating.ordersLeft, sinceSec: f.liquidating.since ? Math.max(0, Math.round((nowMs - Date.parse(f.liquidating.since)) / 1000)) : 0 };
  if (f.killSwitch.active || f.manualRestart.active) return { kind: "stopped", reason: f.manualRestart.reason ?? f.killSwitch.reason ?? "Stopped." };
  if (f.dailyLimitHit.active) return { kind: "daily-stop", reason: (f.dailyLimitHit.reason ?? "").replace(/^\[[\d-]+\]\s*/, "") };
  return { kind: "trading" };
}

/** Hold-to-confirm: progress 0..1 after holding for `heldMs`. */
export const HOLD_MS = 2_000;
export const holdProgress = (heldMs: number) => Math.min(1, Math.max(0, heldMs / HOLD_MS));

/** "+12.34" / "−5.00" with a real minus sign. */
export function signed(v: number, digits = 2): string {
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s}`;
}

/** New alerts to toast: everything after the last one seen, but never the backlog on first load. */
export function newAlerts(alerts: Alert[], lastSeenId: number | null): { show: Alert[]; lastSeenId: number } {
  const maxId = alerts.reduce((m, a) => Math.max(m, a.id), lastSeenId ?? 0);
  if (lastSeenId === null) return { show: [], lastSeenId: maxId };
  return { show: alerts.filter((a) => a.id > lastSeenId).sort((a, b) => a.id - b.id), lastSeenId: maxId };
}
