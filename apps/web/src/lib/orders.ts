// Types and pure helpers for the Orders page (unit-tested, no React here).

export type OrderEvent = { from: string | null; to: string; detail: string | null; at: string };

export type OrderView = {
  id: number;
  pair: string;
  direction: string;
  side: string;
  type: string;
  state: string;
  quantity: number;
  filled: number;
  entryPrice: number | null;
  avgFillPrice: number | null;
  stopPrice: number | null;
  targetPrice: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  events: OrderEvent[];
};

export type PositionView = {
  id: number;
  pair: string;
  quantity: number;
  avgEntry: number;
  stopPrice: number | null;
  targetPrice: number | null;
  lastPrice: number | null;
  feesPaid: number;
  unrealisedPnl: number | null;
  unrealisedPct: number | null;
  progress: number | null;
  openedAt: string;
};

export type TradeView = {
  orderId: number;
  pair: string;
  quantity: number;
  entryPrice: number | null;
  exitPrice: number | null;
  entryFee: number;
  exitFee: number | null;
  realisedPnl: number | null;
  closeReason: string | null;
  openedAt: string;
  closedAt: string;
};

export type TradesResponse = { trades: TradeView[]; totals: { count: number; wins: number; realisedPnl: number; fees: number } };

/** The happy path, left to right. Exits skip the protection step. */
const LONG_PATH = ["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "OPEN", "CLOSED"] as const;
const EXIT_PATH = ["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "CLOSED"] as const;

export const STEP_LABELS: Record<string, string> = {
  QUEUED: "Queued",
  PRECHECK: "Re-check",
  PLACE_ENTRY: "Place order",
  CONFIRM_FILL: "Wait for fill",
  PLACE_PROTECTION: "Place stop + target",
  OPEN: "Open, protected",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  EMERGENCY_CLOSE: "Emergency sell",
};

export type StepStatus = "done" | "current" | "todo" | "stopped" | "emergency";
export type Step = { key: string; label: string; status: StepStatus; detail: string | null };

/**
 * The stepper for one order. A cancelled or failed order shows red on the step where
 * it stopped; an emergency close shows a red step in place of "Open, protected".
 */
export function stepsFor(o: Pick<OrderView, "state" | "direction" | "events">): Step[] {
  const path: readonly string[] = o.direction === "exit" ? EXIT_PATH : LONG_PATH;
  const reached = new Map<string, string | null>();
  for (const e of o.events) reached.set(e.to, e.detail);
  const emergency = reached.has("EMERGENCY_CLOSE");
  const stopped = o.state === "CANCELLED" || o.state === "FAILED";

  // Where on the path the order is (or stopped): the last path state it reached.
  let at = 0;
  for (let i = 0; i < path.length; i++) if (reached.has(path[i]!)) at = i;

  return path.map((key, i) => {
    if (emergency && key === "OPEN") {
      return { key: "EMERGENCY_CLOSE", label: STEP_LABELS.EMERGENCY_CLOSE!, status: "emergency", detail: reached.get("EMERGENCY_CLOSE") ?? null };
    }
    if (stopped && i === at + 1) {
      return { key: o.state, label: STEP_LABELS[o.state]!, status: "stopped", detail: reached.get(o.state) ?? null };
    }
    let status: StepStatus = "todo";
    if (i < at || (i === at && (key === "CLOSED" || stopped))) status = "done";
    else if (i === at) status = o.state === "EMERGENCY_CLOSE" ? "done" : "current";
    if (emergency && key === "CLOSED" && o.state === "EMERGENCY_CLOSE") status = "todo";
    return { key, label: STEP_LABELS[key]!, status, detail: reached.get(key) ?? null };
  });
}

export const isActive = (state: string) => !["CLOSED", "CANCELLED", "FAILED"].includes(state);

/** "+12.34 USDT" / "−5.00 USDT" with a real minus sign; "n/a" when unknown. */
export function money(v: number | null, digits = 2): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s} USDT`;
}

export const pnlTone = (v: number | null) => (v === null || Math.abs(v) < 0.005 ? "flat" : v > 0 ? "up" : "down") as "up" | "down" | "flat";

export const CLOSE_REASONS: Record<string, string> = {
  target: "Target hit",
  stop: "Stop hit",
  "exit-signal": "Exit signal",
  emergency: "Emergency sell",
  reconciled: "Closed on the exchange",
};

/** Where the price sits between stop and target, as a 0 to 100 percentage. */
export function progressPct(p: Pick<PositionView, "progress">): number | null {
  return p.progress === null ? null : Math.round(p.progress * 100);
}
