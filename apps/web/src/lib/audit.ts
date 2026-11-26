// Audit page helpers (unit-tested, no React here).

export type AuditEntry = { id: number; eventType: string; actor: string; payload: any; createdAt: string; hash: string; prevHash: string };
export type AuditList = { entries: AuditEntry[]; types: string[]; actors: string[] };
export type ChainResult = { ok: true; checked: number; lastHash: string; ms: number } | { ok: false; checked: number; badId: number; problem: string; ms: number };

/** One plain line per entry, so the log reads like a story. */
export function summarize(e: Pick<AuditEntry, "eventType" | "payload">): string {
  const p = e.payload ?? {};
  switch (e.eventType) {
    case "order_state":
      return `Order #${p.orderId ?? "?"} ${p.pair ?? ""} ${p.from ? `${p.from} → ` : ""}${p.to ?? ""}${p.detail ? `: ${p.detail}` : ""}`.replace(/\s+/g, " ").trim();
    case "alert":
      return `${String(p.level ?? "").toUpperCase()}: ${p.message ?? p.kind ?? ""}`;
    case "kill_switch":
      return p.event === "liquidation_done" ? `Everything closed in ${p.seconds} s (${p.source}).` : `${p.source === "drawdown" ? "Drawdown stop" : "Kill switch"}${p.alreadyActive ? " pressed again (already closing)" : ""}: ${p.reason ?? ""}`;
    case "setting_change":
      return `${p.file}: ${p.key} ${JSON.stringify(p.old)} → ${JSON.stringify(p.new)}`;
    case "pin_rejected":
      return `Wrong PIN (${p.action ?? "unknown action"}).`;
    case "queued":
      return `Signal #${p.signalId ?? "?"} queued for ${p.pair ?? ""}.`;
    default: {
      const s = JSON.stringify(p);
      return s.length > 140 ? `${s.slice(0, 137)}…` : s;
    }
  }
}

export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;
