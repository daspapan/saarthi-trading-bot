// Edge cases that keep the safety story honest: failure paths, not happy paths.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  HEARTBEAT_STALE_MS,
  beat,
  loadBaseEnv,
  loadSettingsFile,
  migrate,
  num,
  openDb,
  readProcessStatus,
  startHeartbeat,
} from "../src/index.ts";
import { tempDb, validEnv } from "./helpers.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

describe("Process heartbeats (health strip)", () => {
  it("API-02 a process that stops beating shows as down after 15 s", () => {
    const { db } = tempDb();
    beat(db, "risk", "watching");
    const now = Date.now();
    expect(readProcessStatus(db, now).find((p) => p.name === "risk")?.status).toBe("up");
    const later = readProcessStatus(db, now + HEARTBEAT_STALE_MS + 1_000).find((p) => p.name === "risk");
    expect(later).toMatchObject({ status: "down", detail: "watching" });
    expect(later!.lastBeatAgoSec).toBeGreaterThanOrEqual(16);
  });

  it("API-02 startHeartbeat beats immediately and stops when asked", () => {
    const { db } = tempDb();
    const stop = startHeartbeat(db, "feed", () => "hello", 10_000);
    expect(readProcessStatus(db).find((p) => p.name === "feed")).toMatchObject({ status: "up", detail: "hello" });
    stop();
  });
});

describe("Config failure paths", () => {
  it("CFG-02 a non-numeric port is refused in plain language", () => {
    expect(() => loadBaseEnv(validEnv({ API_PORT: "eighty" }))).toThrow('API_PORT="eighty" must be a whole number.');
  });

  it("CFG-03 a missing or broken settings file fails with the file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-cfg-"));
    expect(() => loadSettingsFile(dir, "risk.json")).toThrow(/Could not read .*risk\.json/);
    writeFileSync(join(dir, "risk.json"), "{ not json");
    expect(() => loadSettingsFile(dir, "risk.json")).toThrow(ConfigError);
  });

  it("CFG-03 reading a setting with the wrong type fails loudly", () => {
    const settings = loadSettingsFile(join(ROOT, "config"), "risk.json");
    expect(num(settings, "riskPerTradeBps")).toBe(100);
    expect(() => num(settings, "minConfidence")).toThrow(/not a number/);
    expect(() => num(settings, "nope")).toThrow(/missing/);
  });
});

describe("DB-01 a broken migration changes nothing", () => {
  it("DB-01 a failing migration file is rolled back and not recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-mig-"));
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE a (x INTEGER);");
    writeFileSync(join(dir, "002_bad.sql"), "CREATE TABLE b (x INTEGER); THIS IS NOT SQL;");
    const db = openDb(join(dir, "t.db"));
    expect(() => migrate(db, dir)).toThrow(/Migration 002_bad\.sql failed/);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("a");
    expect(tables).not.toContain("b");
    expect(db.prepare("SELECT name FROM schema_migrations").all()).toEqual([{ name: "001_ok.sql" }]);
  });
});

describe("CFG-05 the analyst process itself refuses to start with a key in sight", () => {
  it("CFG-05 real process: exits with code 1 and a plain message when BINANCE_API_KEY is set", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-proc-"));
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(ROOT, "apps/analyst/src/index.ts")],
      {
        env: { PATH: process.env.PATH, TRADING_MODE: "paper", DB_PATH: join(dir, "t.db"), BINANCE_API_KEY: "leaked-key-123" },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/The analyst must never see exchange keys, but found: BINANCE_API_KEY/);
    expect(result.stdout).not.toContain("leaked-key-123");
  });

  it("CFG-01 real process: the feed refuses a mainnet URL before opening any connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "saarthi-proc-"));
    const result = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(ROOT, "apps/feed/src/index.ts")],
      {
        env: { PATH: process.env.PATH, TRADING_MODE: "paper", DB_PATH: join(dir, "t.db"), BINANCE_WS_URL: "wss://stream.binance.com:9443/ws" },
        encoding: "utf8",
        timeout: 15_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/BINANCE_WS_URL=.* is not a known testnet or demo URL/);
  });
});
