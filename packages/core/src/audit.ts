// Append-only, hash-chained audit log (rule 8).
// Each row's hash = sha256(previous hash + canonical JSON of this row's content).
// Phase 8 adds "Verify chain" and the Audit page; the writing side is needed now.

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
  db.exec("BEGIN IMMEDIATE");
  try {
    const last = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const hash = auditHash(prevHash, eventType, actor, payloadJson, createdAt);
    const info = db
      .prepare(
        "INSERT INTO audit_log (event_type, actor, payload_json, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(eventType, actor, payloadJson, createdAt, prevHash, hash);
    db.exec("COMMIT");
    return { id: Number(info.lastInsertRowid), event_type: eventType, actor, payload_json: payloadJson, created_at: createdAt, prev_hash: prevHash, hash };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
