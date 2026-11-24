// Process heartbeats: each process says "I'm alive" every few seconds,
// and /health turns that into the health strip.

import { type Db, nowIso } from "./db/db.ts";

export const PROCESS_NAMES = ["api", "feed", "analyst", "executor", "risk"] as const;
export type ProcessName = (typeof PROCESS_NAMES)[number];

/** A process is considered down if it has not beaten for this long. */
export const HEARTBEAT_STALE_MS = 15_000;

export function beat(db: Db, name: ProcessName, detail: string | null = null): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO process_heartbeats (name, pid, started_at, last_beat_at, detail)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET pid = excluded.pid, last_beat_at = excluded.last_beat_at, detail = excluded.detail`,
  ).run(name, process.pid, now, now, detail);
}

/** Starts beating now and every `everyMs`. Returns a stop function. */
export function startHeartbeat(db: Db, name: ProcessName, detail: () => string | null, everyMs = 5_000): () => void {
  beat(db, name, detail());
  const timer = setInterval(() => beat(db, name, detail()), everyMs);
  return () => clearInterval(timer);
}

export type ProcessStatus = {
  name: ProcessName;
  status: "up" | "down" | "never-started";
  lastBeatAgoSec: number | null;
  detail: string | null;
};

export function readProcessStatus(db: Db, nowMs = Date.now()): ProcessStatus[] {
  const rows = db.prepare("SELECT name, last_beat_at, detail FROM process_heartbeats").all() as {
    name: string;
    last_beat_at: string;
    detail: string | null;
  }[];
  const byName = new Map(rows.map((r) => [r.name, r]));
  return PROCESS_NAMES.map((name) => {
    const row = byName.get(name);
    if (!row) return { name, status: "never-started", lastBeatAgoSec: null, detail: null };
    const ago = nowMs - Date.parse(row.last_beat_at);
    return {
      name,
      status: ago <= HEARTBEAT_STALE_MS ? "up" : "down",
      lastBeatAgoSec: Math.max(0, Math.round(ago / 1000)),
      detail: row.detail,
    };
  });
}
