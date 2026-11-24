import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  FEED_SOURCE,
  buildSnapshot,
  canonicalJson,
  loadSettingsFile,
  loadSnapshot,
  openDb,
  readSnapshotInputs,
  rollup,
  roundNum,
  seedPaper,
  snapshotHash,
  storeSnapshot,
  upsertCandle,
  writePriceState,
} from "../src/index.ts";
import { fixtureSnapshot } from "./fixtures.ts";
import { tempDb } from "./helpers.ts";
import { BAR, START, syntheticMarket } from "./synthetic.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");
const STRATEGY = loadSettingsFile(CONFIG, "strategy.json");
const RISK = loadSettingsFile(CONFIG, "risk.json");
const MARKET = syntheticMarket();

function inputsAt(barIndex: number) {
  const now = START + (barIndex + 1) * BAR;
  const c15 = Object.fromEntries(Object.entries(MARKET).map(([p, cs]) => [p, cs.slice(0, barIndex + 1)]));
  const c4h = Object.fromEntries(Object.entries(c15).map(([p, cs]) => [p, rollup(cs, "4h").filter((c) => c.openTimeMs + 4 * 3_600_000 <= now)]));
  return {
    nowMs: now,
    mode: "paper",
    pairs: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    prices: {},
    candles15: c15,
    candles4h: c4h,
    account: { equity: 10_000, cash: 10_000, positions: [] },
    today: { trades: 0, pnl: 0, dayStartEquity: 10_000 },
    strategy: STRATEGY,
    risk: RISK,
  };
}

/** A bar where the synthetic market produces at least one candidate. */
function barWithCandidates(): number {
  for (let i = 3_000; i < 6_000; i += 7) if (buildSnapshot(inputsAt(i)).candidates.length) return i;
  throw new Error("no candidates in synthetic market");
}

describe("SNAP-01 the hash ignores key order", () => {
  it("SNAP-01 the same snapshot with keys in a different order has the same hash", () => {
    const a = fixtureSnapshot();
    const shuffle = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shuffle) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffle(x)])) : v;
    const b = shuffle(a) as typeof a;
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
    expect(snapshotHash(b)).toBe(snapshotHash(a));
    expect(snapshotHash(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("SNAP-01 canonical JSON keeps arrays in order (order of candidates matters)", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });
});

describe("SNAP-02 any change changes the hash", () => {
  it.each([
    ["a price", (s: ReturnType<typeof fixtureSnapshot>) => (s.pairs[0]!.price.last = 97412.04)],
    ["an indicator", (s: ReturnType<typeof fixtureSnapshot>) => (s.pairs[0]!.m15!.rsi = 61.26)],
    ["a candidate stop", (s: ReturnType<typeof fixtureSnapshot>) => ((s.candidates[0] as { stop: number }).stop = 96796.29)],
    ["the account cash", (s: ReturnType<typeof fixtureSnapshot>) => (s.account.cash = 9000.01)],
    ["the time", (s: ReturnType<typeof fixtureSnapshot>) => (s.createdAt = "2026-01-01T00:00:00.001Z")],
    ["a fact name", (s: ReturnType<typeof fixtureSnapshot>) => (s.facts[0]!.name = "BTC price")],
  ])("SNAP-02 changing %s changes the hash", (_label, mutate) => {
    const before = snapshotHash(fixtureSnapshot());
    const s = fixtureSnapshot();
    mutate(s);
    expect(snapshotHash(s)).not.toBe(before);
  });
});

describe("SNAP-03 snapshots are stored and fetched by hash", () => {
  it("SNAP-03 store, fetch by hash, get exactly the same snapshot back; storing twice is a no-op", () => {
    const { db } = tempDb();
    const s = fixtureSnapshot();
    const hash = storeSnapshot(db, s);
    expect(hash).toBe(snapshotHash(s));
    expect(storeSnapshot(db, s)).toBe(hash);
    expect((db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number }).n).toBe(1);
    const back = loadSnapshot(db, hash)!;
    expect(back).toEqual(s);
    expect(snapshotHash(back)).toBe(hash);
    expect(loadSnapshot(db, "0".repeat(64))).toBeNull();
  });
});

describe("Snapshot contents (built by code from candles)", () => {
  const snap = buildSnapshot(inputsAt(barWithCandidates()));

  it("AN-01 every candidate's numbers appear in the facts the AI may cite", () => {
    const facts = new Map(snap.facts.map((f) => [f.name, f.value]));
    for (const c of snap.candidates) {
      for (const dp of c.dataPoints) expect(facts.get(dp.name)).toBe(dp.value);
      if (c.direction === "long") {
        expect(facts.get(`${c.strategy} ${c.pair} entry`)).toBe(c.entry);
        expect(facts.get(`${c.strategy} ${c.pair} stop`)).toBe(c.stop);
        expect(facts.get(`${c.strategy} ${c.pair} target`)).toBe(c.target);
      }
    }
  });

  it("AN-01 facts have unique names and every value is a finite, rounded number", () => {
    const names = snap.facts.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
    for (const f of snap.facts) {
      expect(Number.isFinite(f.value)).toBe(true);
      expect(String(f.value).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(6);
    }
  });

  it("IND-06 indicators that aren't available show as null, never NaN", () => {
    const early = buildSnapshot(inputsAt(30));
    expect(early.pairs[0]!.m15!.volumeRatio).toBeNull();
    expect(early.pairs[0]!.m15!.macd).toBeNull();
    expect(JSON.stringify(early)).not.toMatch(/NaN|Infinity/);
  });

  it("STR-07 the snapshot never contains a short", () => {
    for (const c of snap.candidates) expect(["long", "exit"]).toContain(c.direction);
  });

  it("SNAP-02 building twice from the same inputs gives the same hash (deterministic)", () => {
    const i = barWithCandidates();
    expect(snapshotHash(buildSnapshot(inputsAt(i)))).toBe(snapshotHash(buildSnapshot(inputsAt(i))));
  });

  it("AN-01 a snapshot can be built at EVERY point of the history: no fact ever gets two values", () => {
    // Small-valued assets (SOL) once made the strategy and the snapshot round the same fact differently.
    let built = 0;
    for (let i = 40; i < 6_000; i += 37) {
      const s = buildSnapshot(inputsAt(i));
      built += 1;
      const seen = new Map<string, number>();
      for (const f of s.facts) {
        expect(seen.has(f.name)).toBe(false);
        seen.set(f.name, f.value);
      }
    }
    expect(built).toBeGreaterThan(150);
  }, 60_000);

  it("roundNum rounds by size and keeps the sign", () => {
    expect([roundNum(97412.034), roundNum(-3.123456), roundNum(0.12345678), roundNum(-250.555)]).toEqual([97412.03, -3.1235, 0.123457, -250.56]);
  });
});

describe("Reading snapshot inputs from the database", () => {
  it("AN-01 reads closed candles only, price_state, the account and today's numbers, with a read-only connection", () => {
    const { db, path } = tempDb();
    seedPaper(db);
    const now = START + 4_000 * BAR + 300_000; // 5 minutes into a 15m candle
    for (const c of MARKET["BTC/USDT"].slice(0, 4_001)) upsertCandle(db, FEED_SOURCE, c); // includes the candle still forming
    writePriceState(db, { pair: "BTC/USDT", bid: 1, ask: 2, last: 1.5, change24hPct: 0.5, volume24h: 9, timeMs: now }, null, null);

    const ro = openDb(path, { readOnly: true });
    const inp = readSnapshotInputs(ro, { nowMs: now, mode: "paper", strategy: STRATEGY, risk: RISK });
    expect(inp.candles15["BTC/USDT"]!.at(-1)!.openTimeMs).toBe(START + 3_999 * BAR); // the forming candle is left out
    expect(inp.prices["BTC/USDT"]).toEqual({ last: 1.5, bid: 1, ask: 2, change24hPct: 0.5, volume24h: 9 });
    expect(inp.account).toEqual({ equity: 10_000, cash: 10_000, positions: [] });
    expect(inp.today).toEqual({ trades: 0, pnl: 0, dayStartEquity: 10_000 });
    expect(() => ro.exec("DELETE FROM price_state")).toThrow(/readonly/);
  });
});
