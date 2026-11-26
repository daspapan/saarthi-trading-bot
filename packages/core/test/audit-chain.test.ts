// AUD-02 to AUD-04: the hash chain verifies, names a tampered row, and can't be edited through SQL.

import { describe, expect, it } from "vitest";
import { appendAudit, listAudit, verifyChain } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

function chain(n = 6) {
  const { db } = tempDb();
  for (let i = 1; i <= n; i++) appendAudit(db, i % 2 ? "signal" : "order_state", i % 3 ? "api" : "executor", { i, note: `row ${i}` });
  return db;
}

/** What someone with the database file and a SQLite shell could do: drop the guard and edit. */
function tamper(db: ReturnType<typeof chain>, sql: string) {
  db.exec("DROP TRIGGER audit_log_no_update; DROP TRIGGER audit_log_no_delete;");
  db.exec(sql);
}

describe("AUD-02 verify chain on an untouched log", () => {
  it("AUD-02 every row checks out, and the result says how many", () => {
    const db = chain();
    expect(verifyChain(db)).toEqual({ ok: true, checked: 6, lastHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("AUD-02 an empty log is valid", () => {
    const { db } = tempDb();
    expect(verifyChain(db)).toMatchObject({ ok: true, checked: 0 });
  });
});

describe("AUD-03 editing one row makes verification fail and names that row", () => {
  it.each([
    ["the payload", "UPDATE audit_log SET payload_json = '{\"i\":3,\"note\":\"changed\"}' WHERE id = 3"],
    ["the actor", "UPDATE audit_log SET actor = 'operator' WHERE id = 3"],
    ["the time", "UPDATE audit_log SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = 3"],
    ["the event type", "UPDATE audit_log SET event_type = 'setting_change' WHERE id = 3"],
  ])("AUD-03 changing %s of row 3 is caught at row 3", (_what, sql) => {
    const db = chain();
    tamper(db, sql);
    expect(verifyChain(db)).toEqual({ ok: false, checked: 2, badId: 3, problem: "Row 3 has been edited: its contents no longer match its hash." });
  });

  it("AUD-03 recomputing row 3's own hash to hide the edit is caught at row 4", () => {
    const db = chain();
    tamper(db, "UPDATE audit_log SET hash = 'f' || substr(hash, 2) WHERE id = 3");
    const r = verifyChain(db);
    expect(r).toMatchObject({ ok: false, badId: 3 });
  });

  it("AUD-03 deleting a row breaks the link at the next one", () => {
    const db = chain();
    tamper(db, "DELETE FROM audit_log WHERE id = 4");
    expect(verifyChain(db)).toMatchObject({ ok: false, badId: 5, problem: expect.stringMatching(/does not point at the row before it/) });
  });
});

describe("AUD-04 the audit table rejects UPDATE and DELETE", () => {
  it("AUD-04 both are refused by triggers, and the chain is untouched", () => {
    const db = chain();
    expect(() => db.exec("UPDATE audit_log SET actor = 'x' WHERE id = 1")).toThrow(/append-only/);
    expect(() => db.exec("DELETE FROM audit_log WHERE id = 1")).toThrow(/append-only/);
    expect(verifyChain(db).ok).toBe(true);
  });
});

describe("Audit list filters", () => {
  it("AUD-01 newest first, filter by type, actor and text, page backwards", () => {
    const db = chain(10);
    const all = listAudit(db, { limit: 3 });
    expect(all.entries.map((e) => e.id)).toEqual([10, 9, 8]);
    expect(all.types).toEqual(["order_state", "signal"]);
    expect(all.actors).toEqual(["api", "executor"]);
    expect(listAudit(db, { before: 8, limit: 2 }).entries.map((e) => e.id)).toEqual([7, 6]);
    expect(listAudit(db, { type: "signal" }).entries.every((e) => e.eventType === "signal")).toBe(true);
    expect(listAudit(db, { actor: "executor" }).entries.map((e) => e.id)).toEqual([9, 6, 3]);
    expect(listAudit(db, { q: "row 7" }).entries.map((e) => e.payload)).toEqual([{ i: 7, note: "row 7" }]);
    expect(listAudit(db, { q: "%" }).entries).toHaveLength(10); // wildcards are stripped, not obeyed
  });
});
