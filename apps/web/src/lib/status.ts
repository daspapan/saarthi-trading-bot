// Pure display helpers: turn API values into labels, tones and arrows.
// No React here, so these are unit-tested with vitest.

export type Tone = "up" | "down" | "warn" | "idle";
export type Pill = { label: string; tone: Tone };

export function processPill(status: "up" | "down" | "never-started"): Pill {
  if (status === "up") return { label: "UP", tone: "up" };
  if (status === "down") return { label: "DOWN", tone: "down" };
  return { label: "NOT STARTED", tone: "idle" };
}

export function feedPill(status: "ok" | "stale" | "down" | "unknown"): Pill {
  if (status === "ok") return { label: "UP", tone: "up" };
  if (status === "stale") return { label: "STALE", tone: "warn" };
  if (status === "down") return { label: "DOWN", tone: "down" };
  return { label: "UNKNOWN", tone: "idle" };
}

export function exchangePill(status: "ok" | "failing" | "unavailable" | "unknown"): Pill {
  if (status === "ok") return { label: "UP", tone: "up" };
  if (status === "failing") return { label: "FAILING", tone: "warn" };
  if (status === "unavailable") return { label: "DOWN", tone: "down" };
  return { label: "UNKNOWN", tone: "idle" };
}

/** Prices: more decimals for cheaper coins, always the same width per pair. */
export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const decimals = value >= 1000 ? 2 : value >= 1 ? 3 : 6;
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatBps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)} bps`;
}

/** Up, down or flat, for the arrow next to a change. */
export function direction(value: number | null | undefined): "up" | "down" | "flat" {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}

export function agoText(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "no data yet";
  if (sec < 60) return `${sec}s ago`;
  return `${Math.floor(sec / 60)}m ${sec % 60}s ago`;
}
