// The order queue: the only bridge between "the validator approved this" and
// "the executor places an order". (SQS FIFO in Part 02.)
//
//  - Every item has a unique dedupe ID = sha256 of the signal's content, so the
//    same signal arriving twice (a retry, a double submit) is queued once (Q-02).
//    The same ID becomes the exchange's client order ID in phase 6, so a retried
//    order can never be placed twice either.
//  - Items are picked up oldest first (Q-04).
//  - An item older than 15 minutes when picked up is dropped, not executed (Q-06).
//  - The kill switch and the drawdown stop discard everything pending (Q-05).

import { appendAudit } from "./audit.ts";
import type { Db } from "./db/db.ts";
import { canonicalJson, sha256 } from "./util/canonical.ts";

export const QUEUE_MAX_AGE_MIN = 15;

export type QueuePayload = {
  signalId: number;
  snapshotHash: string;
  pair: string;
  direction: "long" | "exit";
  candidateId: string;
  confidence: string | null;
  candidate: unknown;
};

export type QueueItem = {
  id: number;
  dedupeId: string;
  signalId: number;
  pair: string;
  direction: "long" | "exit";
  venue: string;
  status: string;
  statusReason: string | null;
  payload: QueuePayload;
  createdAt: string;
  takenAt: string | null;
};

/** sha256 of what makes a signal THE same signal: its snapshot, pair, direction and candidate. */
export function dedupeIdFor(s: { snapshotHash: string; pair: string; direction: string; candidateId: string }): string {
  return sha256(canonicalJson({ snapshotHash: s.snapshotHash, pair: s.pair, direction: s.direction, candidateId: s.candidateId }));
}

export type EnqueueResult = { queued: true; id: number; dedupeId: string } | { queued: false; duplicateOf: number; dedupeId: string };

/** Adds an approved signal to the queue. A duplicate is ignored (and reported as such). */
export function enqueue(db: Db, payload: QueuePayload, opts: { venue?: string; nowMs?: number } = {}): EnqueueResult {
  const dedupeId = dedupeIdFor(payload);
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO order_queue (dedupe_id, signal_id, pair, payload_json, status, venue, direction, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(dedupeId, payload.signalId, payload.pair, canonicalJson(payload), opts.venue ?? "binance", payload.direction, new Date(opts.nowMs ?? Date.now()).toISOString());
  if (Number(info.changes) === 1) {
    const id = Number(info.lastInsertRowid);
    appendAudit(db, "queued", "validator", { queueId: id, dedupeId, signalId: payload.signalId, pair: payload.pair, direction: payload.direction });
    return { queued: true, id, dedupeId };
  }
  const existing = db.prepare("SELECT id FROM order_queue WHERE dedupe_id = ?").get(dedupeId) as { id: number };
  return { queued: false, duplicateOf: existing.id, dedupeId };
}

type Row = {
  id: number;
  dedupe_id: string;
  signal_id: number;
  pair: string;
  direction: "long" | "exit";
  venue: string;
  status: string;
  status_reason: string | null;
  payload_json: string;
  created_at: string;
  taken_at: string | null;
};

const toItem = (r: Row): QueueItem => ({
  id: r.id,
  dedupeId: r.dedupe_id,
  signalId: r.signal_id,
  pair: r.pair,
  direction: r.direction,
  venue: r.venue,
  status: r.status,
  statusReason: r.status_reason,
  payload: JSON.parse(r.payload_json) as QueuePayload,
  createdAt: r.created_at,
  takenAt: r.taken_at,
});

/**
 * The executor's "give me the next order": the oldest pending item.
 * Items that waited longer than 15 minutes are marked expired on the way (never
 * executed on stale prices). The claim is atomic: two executors can't take the same item.
 */
export function takeNext(db: Db, nowMs: number, maxAgeMin = QUEUE_MAX_AGE_MIN): QueueItem | null {
  for (;;) {
    const row = db.prepare("SELECT * FROM order_queue WHERE status = 'pending' ORDER BY id LIMIT 1").get() as Row | undefined;
    if (!row) return null;
    const ageMin = (nowMs - Date.parse(row.created_at)) / 60_000;
    if (ageMin > maxAgeMin) {
      const reason = `Older than ${maxAgeMin} minutes when picked up (${ageMin.toFixed(1)} min): dropped, not executed.`;
      db.prepare("UPDATE order_queue SET status = 'expired', status_reason = ? WHERE id = ? AND status = 'pending'").run(reason, row.id);
      appendAudit(db, "queue_expired", "executor", { queueId: row.id, pair: row.pair, reason });
      continue;
    }
    const claimed = db
      .prepare("UPDATE order_queue SET status = 'taken', taken_at = ? WHERE id = ? AND status = 'pending'")
      .run(new Date(nowMs).toISOString(), row.id);
    if (Number(claimed.changes) === 1) return toItem({ ...row, status: "taken", taken_at: new Date(nowMs).toISOString() });
    // Someone else claimed it in between: look again.
  }
}

/** Discards every pending item (optionally for one venue). Returns how many. Used by the kill switch and the drawdown stop. */
export function discardPending(db: Db, reason: string, venue?: string): number {
  const info = venue
    ? db.prepare("UPDATE order_queue SET status = 'discarded', status_reason = ? WHERE status = 'pending' AND venue = ?").run(reason, venue)
    : db.prepare("UPDATE order_queue SET status = 'discarded', status_reason = ? WHERE status = 'pending'").run(reason);
  const n = Number(info.changes);
  if (n > 0) appendAudit(db, "queue_discarded", "risk", { count: n, reason, venue: venue ?? "all" });
  return n;
}

export function listQueue(db: Db, limit = 50): QueueItem[] {
  return (db.prepare("SELECT * FROM order_queue ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(toItem);
}

export function queueItemForSignal(db: Db, signalId: number): QueueItem | null {
  const r = db.prepare("SELECT * FROM order_queue WHERE signal_id = ? ORDER BY id LIMIT 1").get(signalId) as Row | undefined;
  return r ? toItem(r) : null;
}

