// Audit page display logic.
import { describe, expect, it } from "vitest";
import { shortHash, summarize } from "../src/lib/audit.ts";

describe("UI-14 audit log lines", () => {
  it("UI-14 common events read as plain sentences", () => {
    expect(summarize({ eventType: "order_state", payload: { orderId: 4, pair: "BTC/USDT", from: "CONFIRM_FILL", to: "PLACE_PROTECTION", detail: "Filled 0.02 at 100050." } })).toBe("Order #4 BTC/USDT CONFIRM_FILL → PLACE_PROTECTION: Filled 0.02 at 100050.");
    expect(summarize({ eventType: "setting_change", payload: { file: "risk.json", key: "riskPerTradeBps", old: 100, new: 50 } })).toBe("risk.json: riskPerTradeBps 100 → 50");
    expect(summarize({ eventType: "kill_switch", payload: { source: "kill-switch", reason: "Pressed on the dashboard.", alreadyActive: false } })).toBe("Kill switch: Pressed on the dashboard.");
    expect(summarize({ eventType: "kill_switch", payload: { event: "liquidation_done", seconds: 2.1, source: "drawdown" } })).toBe("Everything closed in 2.1 s (drawdown).");
    expect(summarize({ eventType: "alert", payload: { level: "warn", message: "Stop hit" } })).toBe("WARN: Stop hit");
    expect(summarize({ eventType: "pin_rejected", payload: { action: "kill" } })).toBe("Wrong PIN (kill).");
  });

  it("UI-14 anything else shows its data, shortened", () => {
    expect(summarize({ eventType: "x", payload: { a: 1 } })).toBe('{"a":1}');
    expect(summarize({ eventType: "x", payload: { a: "y".repeat(300) } })).toHaveLength(138);
    expect(shortHash("0123456789abcdef".repeat(4))).toBe("01234567…cdef");
  });
});
