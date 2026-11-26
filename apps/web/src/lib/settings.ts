// Strategy and Risk page helpers (unit-tested, no React here).

export type Setting =
  | { value: number; min: number; max: number; help: string }
  | { value: string; allowed: string[]; help: string }
  | { value: boolean; help: string }
  | { value: string[]; allowed: string[]; help: string };
export type SettingsFile = Record<string, Setting>;
export type ChangeLine = { key: string; old: unknown; new: unknown; ok: boolean; reason: string | null; restart: string | null };

const GROUPS: Record<string, string> = { statArb: "Stat-arb (BTC/ETH ratio)", momentum: "Momentum", meanReversion: "Mean reversion" };

/** Groups "momentum.stopAtr" under "Momentum"; plain keys under "General". */
export function groupSettings(file: SettingsFile): { group: string; keys: string[] }[] {
  const out = new Map<string, string[]>();
  for (const key of Object.keys(file)) {
    const prefix = key.includes(".") ? key.split(".")[0]! : "";
    const group = GROUPS[prefix] ?? "General";
    out.set(group, [...(out.get(group) ?? []), key]);
  }
  return [...out.entries()].map(([group, keys]) => ({ group, keys }));
}

/** "momentum.minVolumeRatio" -> "Min volume ratio"; "dailyLossLimitBps" -> "Daily loss limit (bps)". */
export function labelFor(key: string): string {
  const last = key.includes(".") ? key.split(".").slice(1).join(".") : key;
  let unit = "";
  let base = last;
  for (const [suffix, u] of [["Bps", "bps"], ["Pct", "%"], ["Seconds", "s"], ["Atr", "ATR"], ["Min", "min"]] as const) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      base = base.slice(0, -suffix.length);
      unit = u;
      break;
    }
  }
  const words = base.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
  return unit ? `${words.charAt(0) + words.slice(1).toLowerCase()} (${unit})` : words.charAt(0) + words.slice(1).toLowerCase();
}

/** Only the values that differ from the file. */
export function pendingChanges(file: SettingsFile, draft: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(draft).filter(([k, v]) => file[k] && JSON.stringify(file[k]!.value) !== JSON.stringify(v)));
}

/** A step for number inputs that matches the range (integers stay integers). */
export function stepFor(s: { value: number; min: number; max: number }): number {
  const ints = [s.value, s.min, s.max].every(Number.isInteger);
  if (ints) return s.max - s.min > 200 ? 10 : 1;
  return s.max - s.min > 5 ? 0.5 : 0.1;
}

export const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "on" : "off") : String(v));
