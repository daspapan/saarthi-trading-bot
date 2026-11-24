// The analyst's API token. The API creates it once (random, file mode 600) in the
// data folder; the analyst process reads it. The API only lets this token do two
// things: submit signals and send a heartbeat. Every other write is refused (CFG-09).
// It is not an exchange key: it can never place or touch an order.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const analystTokenPath = (dbPath: string) => join(dirname(dbPath), "analyst.token");

export function ensureAnalystToken(path: string): string {
  const existing = readAnalystToken(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

export function readAnalystToken(path: string): string | null {
  if (!existsSync(path)) return null;
  const t = readFileSync(path, "utf8").trim();
  return /^[0-9a-f]{64}$/.test(t) ? t : null;
}

/** Constant-time comparison, so timing reveals nothing about the token. */
export function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
