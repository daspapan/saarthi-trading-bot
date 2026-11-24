// Strategy and risk settings: defaults plus the allowed range for each value.
//
// Files (config/strategy.json, config/risk.json) are flat maps:
//   "riskPerTradeBps": { "value": 100, "min": 10, "max": 200, "help": "..." }
// The range is part of the file on purpose: the UI can only change a value
// inside its approved range, and the AI never sees or touches any of this.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ConfigError } from "./env.ts";

const numberSetting = z.strictObject({
  value: z.number(),
  min: z.number(),
  max: z.number(),
  help: z.string(),
});

const choiceSetting = z.strictObject({
  value: z.string(),
  allowed: z.array(z.string()).min(1),
  help: z.string(),
});

const boolSetting = z.strictObject({
  value: z.boolean(),
  help: z.string(),
});

const listSetting = z.strictObject({
  value: z.array(z.string()),
  allowed: z.array(z.string()).min(1),
  help: z.string(),
});

const settingSchema = z.union([numberSetting, choiceSetting, boolSetting, listSetting]);
const settingsFileSchema = z.record(z.string(), settingSchema);

export type Setting = z.infer<typeof settingSchema>;
export type SettingsFile = z.infer<typeof settingsFileSchema>;
export type SettingValue = Setting["value"];

/** Returns null if `value` is allowed for this setting, otherwise a plain reason. */
export function checkValue(key: string, setting: Setting, value: unknown): string | null {
  if ("min" in setting) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${key} must be a number.`;
    if (value < setting.min || value > setting.max) {
      return `${key}=${value} is outside the allowed range ${setting.min} to ${setting.max}.`;
    }
    return null;
  }
  if ("allowed" in setting && Array.isArray(setting.value)) {
    if (!Array.isArray(value) || value.length === 0) return `${key} must be a non-empty list.`;
    const bad = value.filter((v) => typeof v !== "string" || !setting.allowed.includes(v));
    if (bad.length) return `${key} has values that are not allowed: ${bad.join(", ")}.`;
    return null;
  }
  if ("allowed" in setting) {
    if (typeof value !== "string" || !setting.allowed.includes(value)) {
      return `${key}="${String(value)}" is not allowed. Use one of: ${setting.allowed.join(", ")}.`;
    }
    return null;
  }
  if (typeof value !== "boolean") return `${key} must be true or false.`;
  return null;
}

/** Parses a settings object and checks that every default is inside its own range. */
export function parseSettings(fileName: string, raw: unknown): SettingsFile {
  const parsed = settingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${fileName} has an invalid shape: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  }
  for (const [key, setting] of Object.entries(parsed.data)) {
    const problem = checkValue(key, setting, setting.value);
    if (problem) throw new ConfigError(`${fileName}: ${problem}`);
  }
  return parsed.data;
}

export function loadSettingsFile(configDir: string, fileName: "strategy.json" | "risk.json"): SettingsFile {
  const path = join(configDir, fileName);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Could not read ${path}: ${(err as Error).message}`);
  }
  return parseSettings(fileName, raw);
}

export type ChangeResult =
  | { ok: true; settings: SettingsFile; oldValue: SettingValue; newValue: SettingValue }
  | { ok: false; settings: SettingsFile; reason: string };

/**
 * Pure: returns a NEW settings object with one value changed, or the SAME
 * object untouched plus a reason. The old value always stays on failure.
 * (PIN check and audit logging wrap this in the API, phase 8.)
 */
export function applySettingChange(settings: SettingsFile, key: string, value: unknown): ChangeResult {
  const current = settings[key];
  if (!current) return { ok: false, settings, reason: `Unknown setting "${key}".` };
  const problem = checkValue(key, current, value);
  if (problem) return { ok: false, settings, reason: problem };
  const updated = { ...current, value } as Setting;
  return { ok: true, settings: { ...settings, [key]: updated }, oldValue: current.value, newValue: updated.value };
}

/** Convenience: read a numeric setting, failing loudly if the type is wrong. */
export function num(settings: SettingsFile, key: string): number {
  const v = settings[key]?.value;
  if (typeof v !== "number") throw new ConfigError(`Setting ${key} is missing or not a number.`);
  return v;
}
