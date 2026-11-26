// Phone sessions. With ALLOW_LAN=true the dashboard is reachable from your home
// Wi-Fi, and anyone not on this computer must unlock it with the PIN first.
// Unlocking sets an HttpOnly cookie holding an expiry time and an HMAC of it,
// signed with a random secret in data/session.secret (created on first use).

import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { ensureAnalystToken, tokensEqual } from "./token.ts";

export const SESSION_COOKIE = "saarthi_session";
export const SESSION_TTL_MS = 12 * 3_600_000;

export const sessionSecretPath = (dbPath: string) => join(dirname(dbPath), "session.secret");
/** Same format and file mode as the analyst token: 32 random bytes, hex, mode 600. */
export const ensureSessionSecret = (path: string) => ensureAnalystToken(path);

const sign = (secret: string, expMs: number) => createHmac("sha256", secret).update(`saarthi-session:${expMs}`).digest("hex");

export function createSession(secret: string, nowMs = Date.now()): { value: string; expMs: number } {
  const expMs = nowMs + SESSION_TTL_MS;
  return { value: `${expMs}.${sign(secret, expMs)}`, expMs };
}

export function verifySession(secret: string, value: string | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const expMs = Number(m[1]);
  if (expMs <= nowMs) return false;
  return tokensEqual(m[2]!, sign(secret, expMs));
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
export const isLoopback = (addr: string | undefined) => !!addr && LOOPBACK.has(addr);

/**
 * Who is really calling? The phone reaches the API through the web app's LAN
 * gateway, which connects from 127.0.0.1 and passes the phone's address in
 * x-saarthi-client (overwriting anything the phone sent). That header is only
 * trusted when the connection itself comes from this computer.
 */
export function clientAddress(socketAddr: string | undefined, header: string | string[] | undefined): string | undefined {
  if (isLoopback(socketAddr) && typeof header === "string" && header) return header;
  return socketAddr;
}
