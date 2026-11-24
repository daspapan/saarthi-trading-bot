// The live state the validator checks against, read fresh from the database at
// validation time (never taken from the AI's snapshot, which could be minutes old).

import type { Db } from "./db/db.ts";
import { type FeedTrust, getRiskFlag, readFeedTrust } from "./feed/store.ts";
import type { Position } from "./risk.ts";
import type { RiskState } from "./validator.ts";

const DAY = 86_400_000;

/** Order states that are still "in progress" (not finished and not an open position). */
export const IN_PROGRESS_ORDER_STATES = ["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "EMERGENCY_CLOSE"];

export type LiveState = {
  feeds: FeedTrust;
  flags: { killSwitch: boolean; manualRestart: boolean };
  state: RiskState;
  prices: Record<string, number>;
};

export function readLiveState(db: Db, nowMs: number): LiveState {
  const prices: Record<string, number> = {};
  for (const r of db.prepare("SELECT pair, last FROM price_state WHERE last IS NOT NULL").all() as { pair: string; last: number }[]) {
    prices[r.pair] = r.last;
  }

  const eq = db.prepare("SELECT equity, cash FROM equity_snapshots ORDER BY id DESC LIMIT 1").get() as { equity: number; cash: number } | undefined;
  const positions = (
    db.prepare("SELECT pair, quantity, avg_entry FROM positions WHERE status = 'open'").all() as { pair: string; quantity: number; avg_entry: number }[]
  ).map((p): Position => ({ pair: p.pair, quantity: p.quantity, avgEntry: p.avg_entry }));

  // A pair is "pending" if it has a queue item waiting or being executed, or an order mid-flight.
  const marks = IN_PROGRESS_ORDER_STATES.map(() => "?").join(", ");
  const pending = new Set<string>([
    ...(db.prepare("SELECT DISTINCT pair FROM order_queue WHERE status IN ('pending', 'taken')").all() as { pair: string }[]).map((r) => r.pair),
    ...(db.prepare(`SELECT DISTINCT pair FROM orders WHERE state IN (${marks})`).all(...IN_PROGRESS_ORDER_STATES) as { pair: string }[]).map((r) => r.pair),
  ]);

  // Today's new entries: every buy that reached the queue today and wasn't thrown away.
  const dayStart = new Date(Math.floor(nowMs / DAY) * DAY).toISOString();
  const tradesToday = (
    db
      .prepare("SELECT COUNT(*) AS n FROM order_queue WHERE direction = 'long' AND status IN ('pending', 'taken') AND created_at >= ?")
      .get(dayStart) as { n: number }
  ).n;

  return {
    feeds: readFeedTrust(db, nowMs),
    flags: { killSwitch: getRiskFlag(db, "kill_switch").active, manualRestart: getRiskFlag(db, "manual_restart").active },
    state: {
      account: { equity: eq?.equity ?? 0, cash: eq?.cash ?? 0, positions },
      prices,
      pendingPairs: [...pending],
      tradesToday,
      dailyLossLimitHit: getRiskFlag(db, "daily_limit_hit").active,
    },
    prices,
  };
}
