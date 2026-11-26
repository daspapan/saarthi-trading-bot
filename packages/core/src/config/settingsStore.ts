// Changing strategy and risk settings from the dashboard (CFG-04).
//
// Every change must be inside the setting's approved range (checked by the same
// checkValue the loader uses), confirmed with the PIN, and audited. The file is
// rewritten atomically (write a temp file, then rename), so a crash can never leave
// half a file. All the changes in one request apply together or not at all.

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendAudit } from "../audit.ts";
import type { Db } from "../db/db.ts";
import { verifyPin } from "../security/pin.ts";
import { type SettingsFile, type SettingValue, checkValue, loadSettingsFile, parseSettings } from "./settings.ts";

export type SettingsFileName = "strategy.json" | "risk.json";
export const SETTINGS_FILES: readonly SettingsFileName[] = ["strategy.json", "risk.json"];

/** Settings a running process only reads when it starts. */
export const NEEDS_RESTART: Record<string, string> = {
  pairs: "the feed and executor read the pairs when they start",
  feedStaleSeconds: "the feed reads this when it starts",
  feedDisagreementBps: "the feed reads this when it starts",
  feedResumeSeconds: "the feed reads this when it starts",
};

export type ChangeLine = { key: string; old: SettingValue | null; new: unknown; ok: boolean; reason: string | null; restart: string | null };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The diff the UI shows before asking for the PIN. Unchanged values are left out. */
export function previewChanges(settings: SettingsFile, changes: Record<string, unknown>): ChangeLine[] {
  return Object.entries(changes)
    .filter(([key, value]) => !settings[key] || !same(settings[key]!.value, value))
    .map(([key, value]) => {
      const s = settings[key];
      if (!s) return { key, old: null, new: value, ok: false, reason: `Unknown setting "${key}".`, restart: null };
      const problem = checkValue(key, s, value);
      return { key, old: s.value, new: value, ok: problem === null, reason: problem, restart: NEEDS_RESTART[key] ?? null };
    });
}

/** One entry per line, like the hand-written files, so a git diff stays readable. */
export function formatSettings(settings: SettingsFile): string {
  const one = (v: object) => `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")} }`;
  const lines = Object.entries(settings).map(([k, v]) => `  ${JSON.stringify(k)}: ${one(v)}`);
  return `{\n${lines.join(",\n")}\n}\n`;
}

export type ApplyResult =
  | { ok: true; applied: ChangeLine[] }
  | { ok: false; status: number; error: string; lines?: ChangeLine[] };

export function applySettingsChanges(
  db: Db,
  args: { configDir: string; file: string; changes: unknown; pin: unknown; pinHash: string | null; actor: string },
  nowMs = Date.now(),
): ApplyResult {
  if (!SETTINGS_FILES.includes(args.file as SettingsFileName)) return { ok: false, status: 400, error: "file must be strategy.json or risk.json." };
  if (!args.changes || typeof args.changes !== "object" || Array.isArray(args.changes)) return { ok: false, status: 400, error: "changes must be an object of setting name to new value." };
  if (!args.pinHash) return { ok: false, status: 409, error: "No PIN is set. Set PIN_HASH in .env (npm run pin:hash -- <pin>) before changing settings." };
  if (typeof args.pin !== "string" || !verifyPin(args.pin, args.pinHash)) {
    appendAudit(db, "pin_rejected", args.actor, { action: "settings", file: args.file });
    return { ok: false, status: 403, error: "Wrong PIN. No settings were changed." };
  }
  const file = args.file as SettingsFileName;
  const current = loadSettingsFile(args.configDir, file);
  const lines = previewChanges(current, args.changes as Record<string, unknown>);
  if (lines.length === 0) return { ok: false, status: 400, error: "Nothing changed." };
  const bad = lines.filter((l) => !l.ok);
  if (bad.length) return { ok: false, status: 400, error: bad.map((l) => l.reason).join(" "), lines };

  const next: SettingsFile = { ...current };
  for (const l of lines) next[l.key] = { ...current[l.key]!, value: l.new } as SettingsFile[string];

  const ts = new Date(nowMs).toISOString();
  const path = join(args.configDir, file);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const l of lines) {
      db.prepare("INSERT INTO settings_history (file, key, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?)").run(file, l.key, JSON.stringify(l.old), JSON.stringify(l.new), ts);
      appendAudit(db, "setting_change", args.actor, { file, key: l.key, old: l.old, new: l.new });
    }
    // Write the file last, inside the transaction: if the write fails, the history and audit rows roll back.
    const text = formatSettings(next);
    parseSettings(file, JSON.parse(text)); // what we're about to write must load back cleanly
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { ok: true, applied: lines };
}

export function settingsHistory(db: Db, limit = 50) {
  return (db.prepare("SELECT * FROM settings_history ORDER BY id DESC LIMIT ?").all(limit) as { id: number; file: string; key: string; old_value: string; new_value: string; created_at: string }[]).map((r) => ({
    id: r.id,
    file: r.file,
    key: r.key,
    old: JSON.parse(r.old_value) as unknown,
    new: JSON.parse(r.new_value) as unknown,
    createdAt: r.created_at,
  }));
}
