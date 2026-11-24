import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EntryCandidate,
  type ExitCandidate,
  RULE_NAMES,
  type ValidationInput,
  allPassed,
  liveLimitsFrom,
  loadSettingsFile,
  validateSignal,
} from "../src/index.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");
const LIMITS = liveLimitsFrom(loadSettingsFile(CONFIG, "risk.json"));
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);
const MIN = 60_000;

const LONG: EntryCandidate = {
  id: "momentum-long-BTCUSDT-1",
  strategy: "momentum",
  pair: "BTC/USDT",
  direction: "long",
  entry: 100_000,
  stop: 99_400,
  target: 101_200,
  rewardToRisk: 2,
  stopAtr: 1.5,
  atr: 400,
  quantity: 0.025,
  notional: 2_500,
  riskAmount: 15,
  score: 0.5,
  reason: "trend",
  dataPoints: [],
};

const EXIT: ExitCandidate = {
  id: "statArb-exit-ETHUSDT-1",
  strategy: "statArb",
  pair: "ETH/USDT",
  direction: "exit",
  price: 3_000,
  quantity: 0.5,
  score: 1,
  reason: "reverted",
  dataPoints: [],
};

/** Everything fine: all 12 rules pass. Each test breaks exactly one thing. */
function base(): ValidationInput {
  return {
    nowMs: NOW,
    signal: { pair: "BTC/USDT", direction: "long", confidence: "medium", createdAtMs: NOW - 30_000, guardrailsPassed: true, guardrailReasons: [] },
    snapshotCreatedAtMs: NOW - 60_000,
    candidate: { ...LONG },
    feeds: { trusted: true, reason: null },
    flags: { killSwitch: false, manualRestart: false },
    state: { account: { equity: 10_000, cash: 10_000, positions: [] }, prices: {}, pendingPairs: [], tradesToday: 0, dailyLossLimitHit: false },
    currentPrice: 100_100,
    limits: LIMITS,
  };
}

const rule = (input: ValidationInput, n: number) => validateSignal(input).find((r) => r.rule === n)!;

/** Only rule `n` fails, everything else still passes. */
function expectOnlyFails(input: ValidationInput, n: number) {
  const results = validateSignal(input);
  expect(results.filter((r) => !r.passed).map((r) => r.rule)).toEqual([n]);
  return results.find((r) => r.rule === n)!;
}

describe("VAL-01 schema and grounding passed", () => {
  it("VAL-01 passes when the guardrails passed", () => expect(rule(base(), 1).passed).toBe(true));
  it("VAL-01 fails, quoting the guardrails' reasons, when they didn't", () => {
    const i = base();
    i.signal = { ...i.signal, guardrailsPassed: false, guardrailReasons: ['Data point "RSI" says 28 but the snapshot says 61.25.'] };
    expect(expectOnlyFails(i, 1).message).toBe('The guardrails rejected it: Data point "RSI" says 28 but the snapshot says 61.25.');
  });
});

describe("VAL-02 fresh signal (≤ 15 min) built on a fresh snapshot (≤ 2 min)", () => {
  it("VAL-02 passes at exactly 15 and 2 minutes", () => {
    const i = base();
    i.signal = { ...i.signal, createdAtMs: NOW - 15 * MIN };
    i.snapshotCreatedAtMs = NOW - 17 * MIN;
    expect(rule(i, 2).passed).toBe(true);
  });
  it("VAL-02 fails for a signal 15 min + 1 s old", () => {
    const i = base();
    i.signal = { ...i.signal, createdAtMs: NOW - 15 * MIN - 1_000 };
    i.snapshotCreatedAtMs = i.signal.createdAtMs - MIN;
    expect(expectOnlyFails(i, 2).message).toMatch(/Signal is 15\.0 min old \(limit 15\)/);
  });
  it("VAL-02 fails when the snapshot was over 2 minutes old when the signal arrived (slow model)", () => {
    const i = base();
    i.snapshotCreatedAtMs = i.signal.createdAtMs - 2 * MIN - 1_000;
    expect(expectOnlyFails(i, 2).message).toMatch(/snapshot was 2\.0 min old/);
  });
  it("VAL-02 a time in the future (clock trouble) fails too", () => {
    const i = base();
    i.signal = { ...i.signal, createdAtMs: NOW + MIN };
    expect(rule(i, 2).passed).toBe(false);
  });
});

describe("VAL-03 feeds healthy and agreeing", () => {
  it("VAL-03 passes when the feeds are trusted", () => expect(rule(base(), 3).message).toBe("Both price feeds are live and agree."));
  it("VAL-03 fails with the feed's own reason", () => {
    const i = base();
    i.feeds = { trusted: false, reason: "BTC/USDT: feeds disagree by 72.1 bps (limit 50 bps)" };
    expect(expectOnlyFails(i, 3).message).toBe("Price data isn't trusted right now: BTC/USDT: feeds disagree by 72.1 bps (limit 50 bps)");
  });
});

describe("VAL-04 kill switch off and not waiting for a manual restart", () => {
  it("VAL-04 passes when both are off", () => expect(rule(base(), 4).passed).toBe(true));
  it("VAL-04 fails when the kill switch is on", () => {
    const i = base();
    i.flags = { killSwitch: true, manualRestart: false };
    expect(expectOnlyFails(i, 4).message).toBe("The kill switch is on.");
  });
  it("VAL-04 fails while a manual restart is required", () => {
    const i = base();
    i.flags = { killSwitch: false, manualRestart: true };
    expect(expectOnlyFails(i, 4).message).toMatch(/manual restart with the PIN/);
  });
});

describe("VAL-05 daily loss limit", () => {
  it("VAL-05 passes when not hit", () => expect(rule(base(), 5).passed).toBe(true));
  it("VAL-05 fails when hit", () => {
    const i = base();
    i.state = { ...i.state, dailyLossLimitHit: true };
    expect(expectOnlyFails(i, 5).message).toMatch(/no new orders until UTC midnight/);
  });
});

describe("VAL-06 max trades per day", () => {
  it("VAL-06 passes at 9 of 10", () => {
    const i = base();
    i.state = { ...i.state, tradesToday: 9 };
    expect(rule(i, 6)).toMatchObject({ passed: true, message: "9 of 10 trades used today." });
  });
  it("VAL-06 fails at 10 of 10", () => {
    const i = base();
    i.state = { ...i.state, tradesToday: 10 };
    expect(expectOnlyFails(i, 6).message).toBe("10 of 10 trades used today.");
  });
});

describe("VAL-07 risk per trade ≤ 1% of equity", () => {
  it("VAL-07 passes at exactly 1% (100 USDT on 10,000)", () => {
    const i = base();
    i.candidate = { ...LONG, riskAmount: 100 };
    expect(rule(i, 7).passed).toBe(true);
  });
  it("VAL-07 rejects risk above 1% of equity", () => {
    const i = base();
    i.candidate = { ...LONG, riskAmount: 100.01 };
    expect(expectOnlyFails(i, 7).message).toMatch(/= 1\.00% of equity \(limit 1\.00%\)/);
  });
});

describe("VAL-08 per-asset and total exposure limits", () => {
  it("VAL-08 passes inside both limits", () => expect(rule(base(), 8).passed).toBe(true));
  it("VAL-08 fails when this asset would exceed 25%", () => {
    const i = base();
    i.state = { ...i.state, account: { ...i.state.account, cash: 9_000, positions: [{ pair: "BTC/USDT", quantity: 0.01, avgEntry: 100_000 }] } };
    // holding BTC also breaks rule 9, so look at rule 8 only
    expect(rule(i, 8)).toMatchObject({ passed: false, message: expect.stringMatching(/BTC\/USDT would be 35\.00% of equity \(limit 25\.00%\)/) });
  });
  it("VAL-08 fails when total exposure would exceed 60%", () => {
    const i = base();
    i.state = {
      ...i.state,
      account: { equity: 10_000, cash: 4_000, positions: [{ pair: "ETH/USDT", quantity: 1, avgEntry: 2_500 }, { pair: "SOL/USDT", quantity: 17.5, avgEntry: 200 }] },
    };
    expect(expectOnlyFails(i, 8).message).toMatch(/all positions 85\.00% \(limit 60\.00%\)/);
  });
});

describe("VAL-09 no conflicting position or pending order", () => {
  it("VAL-09 passes when nothing is open or pending for the pair", () => expect(rule(base(), 9).passed).toBe(true));
  it("VAL-09 fails when an order for the pair is still in progress", () => {
    const i = base();
    i.state = { ...i.state, pendingPairs: ["BTC/USDT"] };
    expect(expectOnlyFails(i, 9).message).toBe("An order for BTC/USDT is still in progress.");
  });
  it("VAL-09 fails when we already hold the pair", () => {
    const i = base();
    i.state = { ...i.state, account: { ...i.state.account, cash: 9_900, positions: [{ pair: "BTC/USDT", quantity: 0.001, avgEntry: 100_000 }] } };
    i.candidate = { ...LONG, quantity: 0.02, notional: 2_000, riskAmount: 12 }; // keep the per-asset limit out of it
    expect(expectOnlyFails(i, 9).message).toBe("Already holding BTC/USDT.");
  });
});

describe("VAL-10 confidence ≥ minimum (low is logged only)", () => {
  it("VAL-10 medium and high pass", () => {
    for (const confidence of ["medium", "high"]) {
      const i = base();
      i.signal = { ...i.signal, confidence };
      expect(rule(i, 10).passed).toBe(true);
    }
  });
  it("VAL-10 low fails: logged, never traded", () => {
    const i = base();
    i.signal = { ...i.signal, confidence: "low" };
    expect(expectOnlyFails(i, 10).message).toBe("Low confidence is logged only, never traded.");
  });
  it("VAL-10 with the minimum raised to high, medium fails", () => {
    const i = base();
    i.limits = { ...LIMITS, minConfidence: "high" };
    expect(expectOnlyFails(i, 10).message).toBe("Confidence is medium (minimum high).");
  });
  it("VAL-10 a missing confidence fails", () => {
    const i = base();
    i.signal = { ...i.signal, confidence: null };
    expect(rule(i, 10).passed).toBe(false);
  });
});

describe("VAL-11 stop 0.5-5 ATR away and reward-to-risk ≥ 1.5", () => {
  it("VAL-11 passes at 1.5 ATR and 2:1", () => expect(rule(base(), 11).message).toBe("Stop is 1.50 ATR away (allowed 0.5 to 5); reward-to-risk 2.00 (minimum 1.5)."));
  it("VAL-11 fails with the stop too close (0.25 ATR)", () => {
    const i = base();
    i.candidate = { ...LONG, stop: 99_900, target: 100_200 };
    expect(expectOnlyFails(i, 11).message).toMatch(/Stop is 0\.25 ATR away/);
  });
  it("VAL-11 fails with the stop too far (6 ATR)", () => {
    const i = base();
    i.candidate = { ...LONG, stop: 97_600, target: 105_000, riskAmount: 60 };
    expect(expectOnlyFails(i, 11).message).toMatch(/Stop is 6\.00 ATR away/);
  });
  it("VAL-11 fails with reward-to-risk 1.25", () => {
    const i = base();
    i.candidate = { ...LONG, target: 100_750 };
    expect(expectOnlyFails(i, 11).message).toMatch(/reward-to-risk 1\.25 \(minimum 1\.5\)/);
  });
});

describe("VAL-12 entry within 0.3% of the current price", () => {
  it("VAL-12 passes at 0.3% away", () => {
    const i = base();
    i.currentPrice = 100_000 / 1.003;
    expect(rule(i, 12).passed).toBe(true);
  });
  it("VAL-12 fails when the market has moved 0.31% away", () => {
    const i = base();
    i.currentPrice = 100_310;
    expect(expectOnlyFails(i, 12).message).toMatch(/is 0\.31% from the current price 100310 \(limit 0\.30%\)/);
  });
  it("VAL-12 fails with no current price", () => {
    const i = base();
    i.currentPrice = null;
    expect(expectOnlyFails(i, 12).message).toBe("No current price to compare with.");
  });
});

describe("VAL-13 every rule is reported, not just the first failure", () => {
  it("VAL-13 all 12 rules come back, in order, with names and plain messages", () => {
    const r = validateSignal(base());
    expect(r.map((x) => x.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(r.map((x) => x.name)).toEqual(Object.values(RULE_NAMES));
    expect(allPassed(r)).toBe(true);
    for (const x of r) expect(x.message.length).toBeGreaterThan(10);
  });

  it("VAL-13 with several problems at once, every failing rule is listed", () => {
    const i = base();
    i.feeds = { trusted: false, reason: "stale" };
    i.flags = { killSwitch: true, manualRestart: false };
    i.signal = { ...i.signal, confidence: "low" };
    i.currentPrice = 120_000;
    const failed = validateSignal(i).filter((r) => !r.passed).map((r) => r.rule);
    expect(failed).toEqual([3, 4, 10, 12]);
    expect(validateSignal(i)).toHaveLength(12);
  });

  it("VAL-13 an unknown candidate fails every rule that needs its numbers, and still returns 12 lines", () => {
    const i = base();
    i.candidate = null;
    i.signal = { ...i.signal, guardrailsPassed: false, guardrailReasons: ["Unknown candidateId."] };
    const r = validateSignal(i);
    expect(r).toHaveLength(12);
    expect(r.filter((x) => !x.passed).map((x) => x.rule)).toEqual([1, 5, 6, 7, 8, 9, 11, 12]);
  });
});

describe("VAL-14 the validator is pure", () => {
  it("VAL-14 the same input gives the same output, and the input is not modified", () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
      }
      return o;
    };
    const input = deepFreeze(base());
    const a = validateSignal(input);
    const b = validateSignal(input);
    expect(a).toEqual(b);
  });

  it("VAL-14 no database, file, network or clock access", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const nowSpy = vi.spyOn(Date, "now");
    validateSignal(base());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(nowSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    nowSpy.mockRestore();
    const src = readFileSync(join(import.meta.dirname, "..", "src", "validator.ts"), "utf8");
    for (const forbidden of ["node:sqlite", "node:fs", "node:http", "fetch(", "Date.now", "new Date", "../db/", "process.env"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

describe("VAL-15 never margin, never borrowing", () => {
  it("VAL-15 a buy that needs more cash than is free is rejected (spot never borrows)", () => {
    const i = base();
    i.state = { ...i.state, account: { equity: 10_000, cash: 2_000, positions: [] } };
    expect(expectOnlyFails(i, 8).message).toBe("Needs 2500.00 USDT but only 2000.00 USDT cash is free; spot trading never borrows.");
  });

  it("VAL-15 an exit of an asset we don't hold would be a short: rejected", () => {
    const i = base();
    i.signal = { ...i.signal, pair: "ETH/USDT", direction: "exit" };
    i.candidate = EXIT;
    i.currentPrice = 3_000;
    expect(rule(i, 8)).toMatchObject({ passed: false, message: "We don't hold ETH/USDT; selling it would be a short, and spot trading never borrows." });
  });

  it("VAL-15 an exit for more than we hold is rejected", () => {
    const i = base();
    i.signal = { ...i.signal, pair: "ETH/USDT", direction: "exit" };
    i.candidate = { ...EXIT, quantity: 0.6 };
    i.currentPrice = 3_000;
    i.state = { ...i.state, account: { ...i.state.account, positions: [{ pair: "ETH/USDT", quantity: 0.5, avgEntry: 2_900 }] } };
    expect(rule(i, 8).message).toBe("Would sell 0.6 but only 0.5 is held; spot trading never borrows.");
  });

  it("VAL-15 a proper exit of what we hold passes all 12 rules, even with low confidence", () => {
    const i = base();
    i.signal = { ...i.signal, pair: "ETH/USDT", direction: "exit", confidence: "low" };
    i.candidate = EXIT;
    i.currentPrice = 3_001;
    i.state = { ...i.state, account: { ...i.state.account, positions: [{ pair: "ETH/USDT", quantity: 0.5, avgEntry: 2_900 }] }, tradesToday: 99, dailyLossLimitHit: true };
    const r = validateSignal(i);
    expect(r.filter((x) => !x.passed)).toEqual([]);
    expect(r.find((x) => x.rule === 7)!.message).toMatch(/Not needed for an exit/);
  });
});
