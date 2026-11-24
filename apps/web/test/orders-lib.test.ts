// Display logic for the Orders page: the state-machine stepper and P&L wording.
import { describe, expect, it } from "vitest";
import { type OrderEvent, money, pnlTone, progressPct, stepsFor } from "../src/lib/orders.ts";

const ev = (...states: string[]): OrderEvent[] => states.map((to, i) => ({ from: states[i - 1] ?? null, to, detail: `${to} detail`, at: "t" }));
const statuses = (s: ReturnType<typeof stepsFor>) => s.map((x) => `${x.key}:${x.status}`);

describe("UI-13 order stepper", () => {
  it("UI-13 an order waiting for its fill: earlier steps done, current step marked, later ones to do", () => {
    const s = stepsFor({ state: "CONFIRM_FILL", direction: "long", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL") });
    expect(statuses(s)).toEqual(["QUEUED:done", "PRECHECK:done", "PLACE_ENTRY:done", "CONFIRM_FILL:current", "PLACE_PROTECTION:todo", "OPEN:todo", "CLOSED:todo"]);
    expect(s[3]!.detail).toBe("CONFIRM_FILL detail");
  });

  it("UI-13 a closed trade has every step done", () => {
    const s = stepsFor({ state: "CLOSED", direction: "long", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "OPEN", "CLOSED") });
    expect(s.every((x) => x.status === "done")).toBe(true);
  });

  it("UI-13 a cancelled order shows red on the step where it stopped, with the reason", () => {
    const s = stepsFor({ state: "CANCELLED", direction: "long", events: ev("QUEUED", "PRECHECK", "CANCELLED") });
    expect(statuses(s).slice(0, 4)).toEqual(["QUEUED:done", "PRECHECK:done", "CANCELLED:stopped", "CONFIRM_FILL:todo"]);
    expect(s[2]!.detail).toBe("CANCELLED detail");
  });

  it("UI-13 a failed entry shows red after 'Place order'", () => {
    const s = stepsFor({ state: "FAILED", direction: "long", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "FAILED") });
    expect(s[3]).toMatchObject({ key: "FAILED", status: "stopped" });
  });

  it("UI-13 an emergency close replaces 'Open, protected' with a red emergency step", () => {
    const busy = stepsFor({ state: "EMERGENCY_CLOSE", direction: "long", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "EMERGENCY_CLOSE") });
    expect(statuses(busy).slice(4)).toEqual(["PLACE_PROTECTION:done", "EMERGENCY_CLOSE:emergency", "CLOSED:todo"]);
    const done = stepsFor({ state: "CLOSED", direction: "long", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "EMERGENCY_CLOSE", "CLOSED") });
    expect(statuses(done).slice(5)).toEqual(["EMERGENCY_CLOSE:emergency", "CLOSED:done"]);
  });

  it("UI-13 an exit order has no protection step", () => {
    const s = stepsFor({ state: "CONFIRM_FILL", direction: "exit", events: ev("QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL") });
    expect(s.map((x) => x.key)).toEqual(["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "CLOSED"]);
  });
});

describe("UI-13 money is shown honestly", () => {
  it("UI-13 signs, a real minus sign, and n/a for unknown P&L (never a made-up zero)", () => {
    expect(money(12.345)).toBe("+12.35 USDT");
    expect(money(-5)).toBe("−5.00 USDT");
    expect(money(0)).toBe("0.00 USDT");
    expect(money(null)).toBe("n/a");
    expect(pnlTone(0.001)).toBe("flat");
    expect(pnlTone(-1)).toBe("down");
    expect(progressPct({ progress: 0.834 })).toBe(83);
    expect(progressPct({ progress: null })).toBeNull();
  });
});
