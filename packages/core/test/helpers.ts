import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Db, migrate, openDb } from "../src/index.ts";

/** A fresh, migrated SQLite file in a temp folder. */
export function tempDb(): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "saarthi-test-"));
  const path = join(dir, "test.db");
  const db = openDb(path);
  migrate(db);
  return { db, path };
}

/** A minimal valid environment for loadBaseEnv. */
export function validEnv(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { TRADING_MODE: "paper", ...extra };
}
