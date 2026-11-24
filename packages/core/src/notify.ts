// Push alerts to ntfy.sh and/or Telegram. Both are optional and best-effort:
// a failure is logged and stored on the alert, and never touches trading logic or
// the kill switch (AL-02). Each alert is attempted once.

import type { Db } from "./db/db.ts";

export type NotifyConfig = {
  /** Full topic URL, e.g. https://ntfy.sh/my-saarthi-topic */
  ntfyUrl: string | null;
  telegram: { botToken: string; chatId: string } | null;
};

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;
type Log = { warn: (o: object, m?: string) => void };

const PRIORITY: Record<string, string> = { info: "default", warn: "high", critical: "urgent" };

export function notifyConfigFrom(env: Record<string, string | undefined>): NotifyConfig {
  const tg = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID } : null;
  return { ntfyUrl: env.NTFY_URL || null, telegram: tg };
}

/** Sends every alert not yet attempted. Returns how many were sent and how many failed. Never throws. */
export async function sendPendingAlerts(db: Db, cfg: NotifyConfig, deps: { fetch?: Fetch; log?: Log; nowMs?: number } = {}): Promise<{ sent: number; failed: number }> {
  const fetchFn = deps.fetch ?? (globalThis.fetch as unknown as Fetch);
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const rows = db.prepare("SELECT id, level, kind, message FROM alerts WHERE notified_at IS NULL ORDER BY id LIMIT 20").all() as { id: number; level: string; kind: string; message: string }[];
  const mark = db.prepare("UPDATE alerts SET notified_at = ?, notify_error = ? WHERE id = ?");
  let sent = 0;
  let failed = 0;
  for (const a of rows) {
    if (!cfg.ntfyUrl && !cfg.telegram) {
      mark.run(now, null, a.id); // nothing configured: in-app toast only
      continue;
    }
    const errors: string[] = [];
    const attempt = async (name: string, url: string, init: Parameters<Fetch>[1]) => {
      try {
        const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(5_000) });
        if (!res.ok) errors.push(`${name}: HTTP ${res.status}`);
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
      }
    };
    if (cfg.ntfyUrl) {
      await attempt("ntfy", cfg.ntfyUrl, { method: "POST", headers: { Title: `Saarthi: ${a.kind.replaceAll("_", " ")}`, Priority: PRIORITY[a.level] ?? "default", Tags: a.level }, body: a.message });
    }
    if (cfg.telegram) {
      await attempt("telegram", `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: cfg.telegram.chatId, text: `Saarthi ${a.level.toUpperCase()}: ${a.message}` }),
      });
    }
    // Never log the Telegram URL: it contains the bot token.
    if (errors.length) {
      failed += 1;
      deps.log?.warn({ alertId: a.id, errors }, "Could not deliver an alert notification (trading is unaffected).");
    } else sent += 1;
    mark.run(now, errors.length ? errors.join("; ") : null, a.id);
  }
  return { sent, failed };
}
