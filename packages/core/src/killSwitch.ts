// The kill switch and the drawdown stop (rule 7: it always works).
//
// Pressing it only writes to the database: three flags and an audit row, in one
// transaction. That needs nothing but SQLite, so it works with Ollama, the analyst,
// the feed and even the web app stopped (RISK-10); `npm run kill` does the same with
// the API stopped too. The executor sees the "liquidate" flag on its next 1-second
// tick and cancels every order and sells every position.
//
//   kill_switch     no new orders (the validator and the executor's re-check refuse)
//   manual_restart  stays on until someone enters the PIN (RISK-07)
//   liquidate       the executor is closing everything; it clears this when done

import { raiseAlert } from "./alerts.ts";
import { appendAudit } from "./audit.ts";
import type { Db } from "./db/db.ts";
import { getRiskFlag, setRiskFlag } from "./feed/store.ts";
import { discardPending } from "./queue.ts";
import { verifyPin } from "./security/pin.ts";

export type LiquidationSource = "kill-switch" | "drawdown";

const ACTIVE_STATES = "('QUEUED','PRECHECK','PLACE_ENTRY','CONFIRM_FILL','PLACE_PROTECTION','OPEN','EMERGENCY_CLOSE')";

export function activeOrderCount(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE state IN ${ACTIVE_STATES}`).get() as { n: number }).n;
}

/**
 * Stop everything: flags on, pending signals discarded, the executor told to close all.
 * Safe to call twice (RISK-11): a second press while the first is still closing changes nothing.
 */
export function triggerLiquidation(
  db: Db,
  opts: { source: LiquidationSource; reason: string; actor: string },
  nowMs = Date.now(),
): { alreadyActive: boolean; discarded: number } {
  db.exec("BEGIN IMMEDIATE");
  try {
    const alreadyActive = getRiskFlag(db, "liquidate").active;
    let discarded = 0;
    if (!alreadyActive) {
      setRiskFlag(db, "kill_switch", true, opts.reason, nowMs);
      setRiskFlag(db, "manual_restart", true, opts.reason, nowMs);
      setRiskFlag(db, "liquidate", true, opts.source, nowMs);
      discarded = discardPending(db, `${opts.source === "drawdown" ? "Drawdown limit" : "Kill switch"}: ${opts.reason}`);
    }
    appendAudit(db, "kill_switch", opts.actor, { source: opts.source, reason: opts.reason, alreadyActive, discarded, openOrders: activeOrderCount(db) });
    if (!alreadyActive) {
      raiseAlert(
        db,
        {
          level: "critical",
          kind: opts.source === "drawdown" ? "drawdown" : "kill_switch",
          message: `${opts.source === "drawdown" ? "Drawdown limit reached" : "Kill switch pressed"}: ${opts.reason} Cancelling every order and selling every position now. Trading stays stopped until a PIN restart.`,
          key: `${opts.source}:${nowMs}`,
          actor: opts.actor,
        },
        nowMs,
      );
    }
    db.exec("COMMIT");
    return { alreadyActive, discarded };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export type RestartResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Restart trading after a kill switch, a drawdown stop or a protection failure.
 * Needs the correct PIN (RISK-07) and nothing still being closed.
 * The daily loss flag is NOT cleared: that one only resets at UTC midnight.
 */
export function restartTrading(db: Db, pin: string | undefined, pinHash: string | null, actor: string, nowMs = Date.now()): RestartResult {
  const kill = getRiskFlag(db, "kill_switch");
  const manual = getRiskFlag(db, "manual_restart");
  if (!kill.active && !manual.active) return { ok: false, status: 409, error: "Trading is not stopped, so there is nothing to restart." };
  if (!pinHash) return { ok: false, status: 409, error: "No PIN is set. Set PIN_HASH in .env (npm run pin:hash -- <pin>) and restart the API, then try again." };
  if (!pin || !verifyPin(pin, pinHash)) {
    appendAudit(db, "pin_rejected", actor, { action: "restart" });
    return { ok: false, status: 403, error: "Wrong PIN. Trading stays stopped." };
  }
  if (getRiskFlag(db, "liquidate").active || activeOrderCount(db) > 0) {
    return { ok: false, status: 409, error: "Still closing positions. Wait until every order shows Closed, then restart." };
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    setRiskFlag(db, "kill_switch", false, null, nowMs);
    setRiskFlag(db, "manual_restart", false, null, nowMs);
    appendAudit(db, "restart", actor, { previousReason: manual.reason ?? kill.reason });
    raiseAlert(db, { level: "info", kind: "restart", message: "Trading restarted with the PIN. New signals can be traded again.", key: `restart:${nowMs}`, actor }, nowMs);
    db.exec("COMMIT");
    return { ok: true };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
