// Exchange REST health: checked every 30 seconds. Three failures in a row mark
// the exchange unavailable and discard its pending signals; one success
// brings it back.

import { appendAudit } from "../audit.ts";
import { type Db, nowIso } from "../db/db.ts";
import { discardPending } from "../queue.ts";
import { setRiskFlag } from "./store.ts";

export const HEALTH_CHECK_INTERVAL_MS = 30_000;
export const FAILURES_BEFORE_UNAVAILABLE = 3;

export type ExchangeStatus = "ok" | "failing" | "unavailable";

export class ExchangeHealth {
  status: ExchangeStatus = "ok";
  consecutiveFailures = 0;
  lastError: string | null = null;

  /** Record one check. Returns the transition, if any. */
  record(ok: boolean, error: string | null = null): "unavailable" | "recovered" | null {
    if (ok) {
      const wasUnavailable = this.status === "unavailable";
      this.status = "ok";
      this.consecutiveFailures = 0;
      this.lastError = null;
      return wasUnavailable ? "recovered" : null;
    }
    this.consecutiveFailures += 1;
    this.lastError = error;
    if (this.consecutiveFailures >= FAILURES_BEFORE_UNAVAILABLE && this.status !== "unavailable") {
      this.status = "unavailable";
      return "unavailable";
    }
    if (this.status !== "unavailable") this.status = "failing";
    return null;
  }
}

/** Marks every pending queue item for this venue as discarded. Returns how many. */
export function discardPendingSignals(db: Db, venue: string): number {
  return discardPending(db, `${venue} became unavailable (${FAILURES_BEFORE_UNAVAILABLE} failed health checks in a row).`, venue);
}

/**
 * Runs one health check, stores the result and applies the consequences.
 * `check` should resolve if the exchange answered and reject otherwise.
 */
export async function runExchangeHealthCheck(
  db: Db,
  venue: string,
  health: ExchangeHealth,
  check: () => Promise<void>,
): Promise<"unavailable" | "recovered" | null> {
  let transition: "unavailable" | "recovered" | null;
  try {
    await check();
    transition = health.record(true);
  } catch (err) {
    transition = health.record(false, (err as Error).message);
  }

  db.prepare(
    `INSERT INTO exchange_health (venue, status, consecutive_failures, last_error, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(venue) DO UPDATE SET status = excluded.status, consecutive_failures = excluded.consecutive_failures,
       last_error = excluded.last_error, checked_at = excluded.checked_at`,
  ).run(venue, health.status, health.consecutiveFailures, health.lastError, nowIso());

  if (transition === "unavailable") {
    const discarded = discardPendingSignals(db, venue);
    setRiskFlag(db, "exchange_unavailable", true, `${venue} failed ${FAILURES_BEFORE_UNAVAILABLE} health checks in a row`);
    appendAudit(db, "health_alarm", "feed", { venue, kind: "exchange_unavailable", discarded, lastError: health.lastError });
  } else if (transition === "recovered") {
    setRiskFlag(db, "exchange_unavailable", false, null);
    appendAudit(db, "health_resumed", "feed", { venue, kind: "exchange_available" });
  }
  return transition;
}
