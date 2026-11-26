// The command palette (Cmd/Ctrl + K) and keyboard shortcuts. Pure logic, unit-tested.

export type Command = { id: string; label: string; hint?: string; keys?: string; href?: string; action?: string };

export const PAGES: Command[] = [
  { id: "go-cockpit", label: "Cockpit", hint: "Equity, risk gauges, kill switch", keys: "g c", href: "/" },
  { id: "go-analyst", label: "AI Analyst", hint: "Signals and their evidence", keys: "g a", href: "/analyst" },
  { id: "go-orders", label: "Orders", hint: "Positions, order steps, trade history", keys: "g o", href: "/orders" },
  { id: "go-performance", label: "Performance", hint: "Equity curve, returns vs BTC", keys: "g p", href: "/performance" },
  { id: "go-backtest", label: "Backtest Lab", hint: "Test strategies on history", keys: "g b", href: "/backtest" },
  { id: "go-settings", label: "Strategy and Risk", hint: "Change settings with the PIN", keys: "g s", href: "/settings" },
  { id: "go-audit", label: "Audit", hint: "The hash-chained log", keys: "g l", href: "/audit" },
];

export const ACTIONS: Command[] = [
  { id: "kill", label: "Kill switch", hint: "Open the kill switch", keys: "!", href: "/#kill-switch" },
  { id: "analyse", label: "Analyse now", hint: "Ask the AI analyst to run", action: "analyse" },
  { id: "verify", label: "Verify audit chain", hint: "Recompute every hash", href: "/audit?verify=1" },
  { id: "theme", label: "Switch light / dark theme", keys: "t", action: "theme" },
  { id: "help", label: "Keyboard shortcuts", keys: "?", action: "help" },
];

export const ALL_COMMANDS = [...PAGES, ...ACTIONS];

/** Simple fuzzy match: every typed character appears in order. Earlier, tighter matches rank first. */
export function score(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let pos = -1;
  let gaps = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return null;
    gaps += next - pos - 1;
    pos = next;
  }
  return 100 + gaps;
}

export function filterCommands(query: string, commands = ALL_COMMANDS): Command[] {
  return commands
    .map((c) => ({ c, s: Math.min(score(query, c.label) ?? Infinity, (score(query, c.hint ?? "") ?? Infinity) + 50) }))
    .filter((x) => Number.isFinite(x.s))
    .sort((a, b) => a.s - b.s)
    .map((x) => x.c);
}

/** Two-key shortcuts ("g" then a letter). Returns the command once the sequence completes. */
export function matchShortcut(pending: string, key: string): { command: Command | null; pending: string } {
  const seq = pending ? `${pending} ${key}` : key;
  const exact = ALL_COMMANDS.find((c) => c.keys === seq);
  if (exact) return { command: exact, pending: "" };
  const prefix = ALL_COMMANDS.some((c) => c.keys?.startsWith(`${seq} `));
  return { command: null, pending: prefix ? seq : "" };
}

/** Shortcuts are ignored while typing in a field. */
export const isTypingTarget = (tag: string | undefined, editable = false) => editable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
