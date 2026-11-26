// Append-only, hash-chained audit log (rule 8).
// Each row's hash = sha256(previous hash + canonical JSON of this row's content).
// verifyChain() recomputes every hash; the Audit page's "Verify chain" button calls it.

import { type Db, nowIso } from "./db/db.ts";
import { canonicalJson, sha256 } from "./util/canonical.ts";

export const GENESIS_HASH = "0".repeat(64);

export type AuditRow = {
  id: number;
  event_type: string;
  actor: string;
  payload_json: string;
  created_at: string;
  prev_hash: string;
  hash: string;
};

export function auditHash(prevHash: string, eventType: string, actor: string, payloadJson: string, createdAt: string) {
  return sha256(prevHash + canonicalJson({ eventType, actor, payloadJson, createdAt }));
}

export function appendAudit(db: Db, eventType: string, actor: string, payload: unknown): AuditRow {
  const payloadJson = canonicalJson(payload);
  const createdAt = nowIso();
  // BEGIN IMMEDIATE takes the write lock before reading the last hash, so two
  // processes writing at once can't both chain onto the same previous row.
  // If the caller already holds a transaction (it must have started it with
  // BEGIN IMMEDIATE), we simply join it and the caller commits.
  const ownTransaction = !(db as unknown as { isTransaction: boolean }).isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  try {
    const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = auditHash(prevHash, eventType, actor, payloadJson, createdAt);
    const info = db
      .prepare(
        "INSERT INTO audit_log (event_type, actor, payload_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(eventType, actor, payloadJson, createdAt, prevHash, hash);
    if (ownTransaction) db.exec("COMMIT");
    return { id: Number(info.lastInsertRowid), event_type: eventType, actor, payload_json: payloadJson, created_at: createdAt, prev_hash: prevHash, hash };
  } catch (err) {
    if (ownTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

export type ChainResult =
  | { ok: true; checked: number; lastHash: string }
  | { ok: false; checked: number; badId: number; problem: string };

/**
 * Recomputes the chain from the first row (AUD-02). The first row whose stored
 * hash or link doesn't match is named (AUD-03), so an edited row can't hide:
 * changing any field changes that row's hash, and the next row's prev_hash no
 * longer points at it.
 */
export function verifyChain(db: Db): ChainResult {
  let prev = GENESIS_HASH;
  let checked = 0;
  for (const r of db.prepare("SELECT * FROM audit_log ORDER BY id").iterate() as Iterable<AuditRow>) {
    if (r.prev_hash !== prev) {
      return { ok: false, checked, badId: r.id, problem: `Row ${r.id} does not point at the row before it: a row was changed, removed or inserted.` };
    }
    const expected = auditHash(r.prev_hash, r.event_type, r.actor, r.payload_json, r.created_at);
    if (expected !== r.hash) {
      return { ok: false, checked, badId: r.id, problem: `Row ${r.id} has been edited: its contents no longer match its hash.` };
    }
    prev = r.hash;
    checked += 1;
  }
  return { ok: true, checked, lastHash: prev };
}

export type AuditEntry = { id: number; eventType: string; actor: string; payload: unknown; createdAt: string; hash: string; prevHash: string };

/** Newest first, with optional filters. `before` pages backwards by id. */
export function listAudit(db: Db, f: { type?: string; actor?: string; q?: string; before?: number; limit?: number } = {}): { entries: AuditEntry[]; types: string[]; actors: string[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.type) { where.push("event_type = ?"); args.push(f.type); }
  if (f.actor) { where.push("actor = ?"); args.push(f.actor); }
  if (f.q) { where.push("payload_json LIKE ?"); args.push(`%${f.q.replace(/[%_]/g, "")}%`); }
  if (f.before) { where.push("id < ?"); args.push(f.before); }
  const limit = Math.min(500, Math.max(1, f.limit ?? 100));
  const rows = db
    .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, limit) as AuditRow[];
  const distinct = (col: string) => (db.prepare(`SELECT DISTINCT ${col} AS v FROM audit_log ORDER BY v`).all() as { v: string }[]).map((r) => r.v);
  return {
    entries: rows.map((r) => ({ id: r.id, eventType: r.event_type, actor: r.actor, payload: JSON.parse(r.payload_json), createdAt: r.created_at, hash: r.hash, prevHash: r.prev_hash })),
    types: distinct("event_type"),
    actors: distinct("actor"),
  };
}
