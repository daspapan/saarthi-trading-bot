// RISK-10: `npm run kill -- <PIN>` works with the API and web app stopped: it only needs the database.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { getRiskFlag, hashPin, migrate, openDb } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

function run(dbPath: string, args: string[], pinHash?: string) {
  try {
    const out = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "scripts/kill.ts", ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH, TRADING_MODE: "paper", DB_PATH: dbPath, ...(pinHash ? { PIN_HASH: pinHash } : {}) },
      encoding: "utf8",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { code: e.status, out: e.stdout + e.stderr };
  }
}

describe("RISK-10 the kill switch from a terminal", () => {
  it("RISK-10 with the right PIN it sets the flags, and says the executor isn't running", () => {
    const { path } = tempDb();
    const r = run(path, ["2468"], hashPin("2468"));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Kill switch on\. 0 pending signal\(s\) discarded\./);
    expect(r.out).toMatch(/The executor isn't running/);
    const db = openDb(path);
    migrate(db);
    expect(getRiskFlag(db, "liquidate").active).toBe(true);
    expect(getRiskFlag(db, "manual_restart").active).toBe(true);
    expect((db.prepare("SELECT actor FROM audit_log WHERE event_type = 'kill_switch'").get() as { actor: string }).actor).toBe("operator-cli");
  }, 30_000);

  it("RISK-08 a wrong PIN from the terminal changes nothing", () => {
    const { path } = tempDb();
    const r = run(path, ["1111"], hashPin("2468"));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Wrong or missing PIN/);
    const db = openDb(path);
    expect(getRiskFlag(db, "kill_switch").active).toBe(false);
  }, 30_000);
});
