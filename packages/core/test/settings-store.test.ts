// CFG-04: setting changes only within approved ranges, confirmed with the PIN, audited, atomic.

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingsChanges, formatSettings, hashPin, loadSettingsFile, parseSettings, previewChanges, settingsHistory, verifyChain } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const REAL = join(import.meta.dirname, "..", "..", "..", "config");
const PIN = hashPin("2468");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "saarthi-cfg-"));
  for (const f of ["strategy.json", "risk.json"]) copyFileSync(join(REAL, f), join(dir, f));
  const { db } = tempDb();
  const apply = (file: string, changes: unknown, pin: unknown = "2468", pinHash: string | null = PIN) =>
    applySettingsChanges(db, { configDir: dir, file, changes, pin, pinHash, actor: "operator" });
  return { dir, db, apply };
}

const audits = (db: ReturnType<typeof tempDb>["db"], type: string) =>
  (db.prepare("SELECT payload_json FROM audit_log WHERE event_type = ? ORDER BY id").all(type) as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json));

describe("CFG-04 setting changes", () => {
  it("CFG-04 a change inside the range, with the PIN, is saved, recorded in history and audited", () => {
    const s = setup();
    const r = s.apply("risk.json", { riskPerTradeBps: 50, dailyLossLimitBps: 150 });
    expect(r).toEqual({ ok: true, applied: [
      { key: "riskPerTradeBps", old: 100, new: 50, ok: true, reason: null, restart: null },
      { key: "dailyLossLimitBps", old: 200, new: 150, ok: true, reason: null, restart: null },
    ] });
    const now = loadSettingsFile(s.dir, "risk.json");
    expect(now.riskPerTradeBps!.value).toBe(50);
    expect(now.dailyLossLimitBps!.value).toBe(150);
    expect(now.riskPerTradeBps).toMatchObject({ min: 10, max: 200 }); // ranges can't be changed
    expect(settingsHistory(s.db).map((h) => [h.key, h.old, h.new])).toEqual([["dailyLossLimitBps", 200, 150], ["riskPerTradeBps", 100, 50]]);
    expect(audits(s.db, "setting_change")).toEqual([
      { file: "risk.json", key: "riskPerTradeBps", old: 100, new: 50 },
      { file: "risk.json", key: "dailyLossLimitBps", old: 200, new: 150 },
    ]);
    expect(verifyChain(s.db).ok).toBe(true);
  });

  it("CFG-04 one value outside its range refuses the whole batch, and the file is untouched", () => {
    const s = setup();
    const before = readFileSync(join(s.dir, "risk.json"), "utf8");
    const r = s.apply("risk.json", { riskPerTradeBps: 50, maxDrawdownBps: 9000 });
    expect(r).toMatchObject({ ok: false, status: 400, error: "maxDrawdownBps=9000 is outside the allowed range 500 to 2500." });
    expect(readFileSync(join(s.dir, "risk.json"), "utf8")).toBe(before);
    expect(settingsHistory(s.db)).toEqual([]);
  });

  it("CFG-04 a wrong PIN changes nothing and is audited; no PIN set means no changes at all", () => {
    const s = setup();
    expect(s.apply("risk.json", { riskPerTradeBps: 50 }, "1111")).toMatchObject({ ok: false, status: 403 });
    expect(s.apply("risk.json", { riskPerTradeBps: 50 }, null)).toMatchObject({ ok: false, status: 403 });
    expect(audits(s.db, "pin_rejected")).toEqual([{ action: "settings", file: "risk.json" }, { action: "settings", file: "risk.json" }]);
    expect(s.apply("risk.json", { riskPerTradeBps: 50 }, "2468", null)).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/No PIN is set/) });
    expect(loadSettingsFile(s.dir, "risk.json").riskPerTradeBps!.value).toBe(100);
  });

  it.each([
    [{ leverage: 10 }, 'Unknown setting "leverage".'],
    [{ "momentum.targetR": "3" }, "momentum.targetR must be a number."],
    [{ "momentum.enabled": "yes" }, "momentum.enabled must be true or false."],
    [{ pairs: ["BTC/USDT", "DOGE/USDT"] }, "pairs has values that are not allowed: DOGE/USDT."],
    [{ pairs: [] }, "pairs must be a non-empty list."],
  ])("CFG-04 %j is refused: %s", (changes, reason) => {
    const s = setup();
    expect(s.apply("strategy.json", changes)).toMatchObject({ ok: false, status: 400, error: reason });
  });

  it("CFG-04 bad requests: another file name, no changes, nothing actually different", () => {
    const s = setup();
    expect(s.apply("../../etc/passwd", { a: 1 })).toMatchObject({ ok: false, status: 400 });
    expect(s.apply("risk.json", [1, 2])).toMatchObject({ ok: false, status: 400 });
    expect(s.apply("risk.json", { riskPerTradeBps: 100 })).toMatchObject({ ok: false, status: 400, error: "Nothing changed." });
  });

  it("CFG-04 the preview shows the diff and flags settings that need a restart", () => {
    const s = setup();
    const lines = previewChanges(loadSettingsFile(s.dir, "strategy.json"), { "momentum.enabled": false, pairs: ["BTC/USDT", "ETH/USDT"], "statArb.zEntry": 2 });
    expect(lines).toEqual([
      { key: "momentum.enabled", old: true, new: false, ok: true, reason: null, restart: null },
      { key: "pairs", old: ["BTC/USDT", "ETH/USDT", "SOL/USDT"], new: ["BTC/USDT", "ETH/USDT"], ok: true, reason: null, restart: expect.stringMatching(/feed and executor/) },
    ]);
  });

  it("CFG-04 the file is replaced in one step (no temp files left) and reads back the same", () => {
    const s = setup();
    s.apply("strategy.json", { "momentum.targetR": 3 });
    expect(readdirSync(s.dir).sort()).toEqual(["risk.json", "strategy.json"]);
    const reread = loadSettingsFile(s.dir, "strategy.json");
    const original = loadSettingsFile(REAL, "strategy.json");
    expect({ ...reread, "momentum.targetR": original["momentum.targetR"] }).toEqual(original);
  });

  it("CFG-04 the writer keeps every field of the real config files", () => {
    for (const f of ["strategy.json", "risk.json"] as const) {
      const real = loadSettingsFile(REAL, f);
      expect(parseSettings(f, JSON.parse(formatSettings(real)))).toEqual(real);
    }
  });
});
