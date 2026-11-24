// Alerts: one row per event, shown as a toast in the dashboard and optionally pushed
// to ntfy.sh or Telegram. Every alert is also written to the audit log.
//
// AL-01: each event has a dedupe key (for example "stop_hit:12" or "daily_warn:2026-11-24"),
// and the key is unique, so checking the same condition every 5 seconds raises it once.

import { appendAudit } from "./audit.ts";
import type { Db } from "./db/db.ts";

export type AlertLevel = "info" | "warn" | "critical";

export type Alert = {
  id: number;
  level: AlertLevel;
  kind: string;
  message: string;
  orderId: number | null;
  createdAt: string;
};

export type NewAlert = { level: AlertLevel; kind: string; message: string; key: string; orderId?: number; actor?: string };

/** Raises an alert unless one with the same key already exists. Returns true if it was new. */
export function raiseAlert(db: Db, a: NewAlert, nowMs = Date.now()): boolean {
  const own = !(db as unknown as { isTransaction: boolean }).isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    const r = db
      .prepare("INSERT OR IGNORE INTO alerts (level, kind, message, dedupe_key, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(a.level, a.kind, a.message, a.key, a.orderId ?? null, new Date(nowMs).toISOString());
    const created = Number(r.changes) > 0;
    if (created) {
      appendAudit(db, "alert", a.actor ?? "system", { level: a.level, kind: a.kind, message: a.message, key: a.key, ...(a.orderId ? { orderId: a.orderId } : {}) });
    }
    if (own) db.exec("COMMIT");
    return created;
  } catch (err) {
    if (own) db.exec("ROLLBACK");
    throw err;
  }
}

type Row = { id: number; level: AlertLevel; kind: string; message: string; order_id: number | null; created_at: string };
const toAlert = (r: Row): Alert => ({ id: r.id, level: r.level, kind: r.kind, message: r.message, orderId: r.order_id, createdAt: r.created_at });

/** Alerts newer than `afterId`, oldest first (what the toaster polls). Without afterId: the latest `limit`, newest first. */
export function listAlerts(db: Db, opts: { afterId?: number; limit?: number } = {}): Alert[] {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  if (opts.afterId !== undefined) {
    return (db.prepare("SELECT * FROM alerts WHERE id > ? ORDER BY id LIMIT ?").all(opts.afterId, limit) as Row[]).map(toAlert);
  }
  return (db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toAlert);
}

export function latestAlertId(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM alerts").get() as { id: number }).id;
}
