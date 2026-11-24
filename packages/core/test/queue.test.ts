import { describe, expect, it } from "vitest";
import { type QueuePayload, canonicalJson, dedupeIdFor, discardPending, enqueue, listQueue, readLiveState, seedPaper, sha256, takeNext } from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);
const MIN = 60_000;

function payload(o: Partial<QueuePayload> = {}): QueuePayload {
  return { signalId: 1, snapshotHash: "a".repeat(64), pair: "BTC/USDT", direction: "long", candidateId: "momentum-long-BTCUSDT-1", confidence: "medium", candidate: {}, ...o };
}

/** A queue with signal rows to point at (order_queue.signal_id is a foreign key). */
function db(seed = false) {
  const { db } = tempDb();
  if (seed) seedPaper(db); // seeding resets signals, so it comes first
  for (let i = 1; i <= 10; i++) {
    db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES ('X', 'long', '{}', 'test', 'x')").run();
  }
  return db;
}

describe("Q-01 a passing signal is queued with dedupe_id = sha256(signal)", () => {
  it("Q-01 the dedupe ID is the SHA-256 of the signal's identity (snapshot, pair, direction, candidate)", () => {
    const d = db();
    const r = enqueue(d, payload(), { nowMs: T0 });
    const expected = sha256(canonicalJson({ snapshotHash: "a".repeat(64), pair: "BTC/USDT", direction: "long", candidateId: "momentum-long-BTCUSDT-1" }));
    expect(r).toEqual({ queued: true, id: 1, dedupeId: expected });
    expect(dedupeIdFor(payload())).toBe(expected);
    expect(listQueue(d)[0]).toMatchObject({ dedupeId: expected, status: "pending", pair: "BTC/USDT", direction: "long", venue: "binance" });
  });

  it("Q-01 queuing writes an audit row", () => {
    const d = db();
    enqueue(d, payload(), { nowMs: T0 });
    expect(d.prepare("SELECT event_type, actor FROM audit_log").all()).toEqual([{ event_type: "queued", actor: "validator" }]);
  });
});

describe("Q-02 the same signal sent twice is queued once", () => {
  it("Q-02 a second identical signal is ignored and points at the first", () => {
    const d = db();
    const a = enqueue(d, payload(), { nowMs: T0 });
    const b = enqueue(d, payload({ signalId: 2, confidence: "high" }), { nowMs: T0 + 1_000 }); // a resubmission of the same signal
    expect(b).toEqual({ queued: false, duplicateOf: 1, dedupeId: a.dedupeId });
    expect(listQueue(d)).toHaveLength(1);
  });

  it("Q-02 a different candidate or snapshot is a different signal", () => {
    const d = db();
    enqueue(d, payload(), { nowMs: T0 });
    expect(enqueue(d, payload({ candidateId: "momentum-long-BTCUSDT-2" }), { nowMs: T0 }).queued).toBe(true);
    expect(enqueue(d, payload({ snapshotHash: "b".repeat(64) }), { nowMs: T0 }).queued).toBe(true);
  });
});

describe("Q-04 processed in arrival order", () => {
  it("Q-04 the oldest pending item comes out first, and each item only once", () => {
    const d = db();
    enqueue(d, payload({ candidateId: "c1" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "c2", pair: "ETH/USDT" }), { nowMs: T0 + 1_000 });
    enqueue(d, payload({ candidateId: "c3" }), { nowMs: T0 + 2_000 });
    expect([takeNext(d, T0 + 5_000)!.payload.candidateId, takeNext(d, T0 + 5_000)!.payload.candidateId, takeNext(d, T0 + 5_000)!.payload.candidateId]).toEqual(["c1", "c2", "c3"]);
    expect(takeNext(d, T0 + 5_000)).toBeNull();
  });

  it("Q-04 a taken item is marked taken with the time, so it isn't handed out again", () => {
    const d = db();
    enqueue(d, payload(), { nowMs: T0 });
    const item = takeNext(d, T0 + 1_000)!;
    expect(item).toMatchObject({ status: "taken", takenAt: new Date(T0 + 1_000).toISOString() });
    expect(listQueue(d)[0]!.status).toBe("taken");
  });
});

describe("Q-05 the kill switch and the drawdown stop discard every pending item", () => {
  it("Q-05 all pending items are discarded with the reason; already-taken items are left to the executor", () => {
    const d = db();
    enqueue(d, payload({ candidateId: "c1" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "c2" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "c3" }), { nowMs: T0 });
    takeNext(d, T0); // c1 is already being executed
    expect(discardPending(d, "Kill switch pressed")).toBe(2);
    expect(listQueue(d).map((q) => [q.payload.candidateId, q.status, q.statusReason])).toEqual([
      ["c3", "discarded", "Kill switch pressed"],
      ["c2", "discarded", "Kill switch pressed"],
      ["c1", "taken", null],
    ]);
    expect(takeNext(d, T0)).toBeNull();
    expect(d.prepare("SELECT payload_json FROM audit_log WHERE event_type = 'queue_discarded'").get()).toEqual({
      payload_json: '{"count":2,"reason":"Kill switch pressed","venue":"all"}',
    });
  });

  it("Q-05 discarding an empty queue is safe and writes nothing", () => {
    const d = db();
    expect(discardPending(d, "Drawdown limit")).toBe(0);
    expect(d.prepare("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
  });

  it("Q-05 discarding for one venue leaves the others", () => {
    const d = db();
    enqueue(d, payload({ candidateId: "c1" }), { nowMs: T0, venue: "binance" });
    enqueue(d, payload({ candidateId: "c2" }), { nowMs: T0, venue: "bybit" });
    expect(discardPending(d, "binance down", "binance")).toBe(1);
    expect(takeNext(d, T0)!.venue).toBe("bybit");
  });
});

describe("Q-06 an item older than 15 minutes when picked up is dropped", () => {
  it("Q-06 at 15 minutes it is still executed; at 15 min + 1 s it is expired and the next one comes out", () => {
    const d = db();
    enqueue(d, payload({ candidateId: "old" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "new" }), { nowMs: T0 + 10 * MIN });
    expect(takeNext(d, T0 + 15 * MIN)!.payload.candidateId).toBe("old");

    const d2 = db();
    enqueue(d2, payload({ candidateId: "old" }), { nowMs: T0 });
    enqueue(d2, payload({ candidateId: "new" }), { nowMs: T0 + 10 * MIN });
    expect(takeNext(d2, T0 + 15 * MIN + 1_000)!.payload.candidateId).toBe("new");
    const old = listQueue(d2).find((q) => q.payload.candidateId === "old")!;
    expect(old.status).toBe("expired");
    expect(old.statusReason).toMatch(/^Older than 15 minutes when picked up \(15\.0 min\): dropped, not executed\.$/);
    expect(d2.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'queue_expired'").get()).toEqual({ n: 1 });
  });
});

describe("Live state for the validator", () => {
  it("VAL-09 queued or in-flight pairs count as pending; today's queued buys count as trades", () => {
    const d = db(true);
    enqueue(d, payload({ candidateId: "c1" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "c2", pair: "SOL/USDT", direction: "exit" }), { nowMs: T0 });
    enqueue(d, payload({ candidateId: "c3", pair: "ETH/USDT" }), { nowMs: T0 });
    discardPending(d, "test"); // discarded ones are not pending and not trades
    enqueue(d, payload({ candidateId: "c4", pair: "ETH/USDT" }), { nowMs: T0 });
    d.prepare(
      "INSERT INTO orders (client_order_id, venue, pair, side, type, quantity, state, created_at, updated_at) VALUES ('x', 'binance', 'SOL/USDT', 'buy', 'limit', 1, 'CONFIRM_FILL', 'x', 'x')",
    ).run();
    const live = readLiveState(d, T0 + MIN);
    expect(new Set(live.state.pendingPairs)).toEqual(new Set(["ETH/USDT", "SOL/USDT"]));
    expect(live.state.tradesToday).toBe(1);
    expect(live.flags).toEqual({ killSwitch: false, manualRestart: false });
    expect(live.state.account).toEqual({ equity: 10_000, cash: 10_000, positions: [] });
    expect(live.feeds.trusted).toBe(false); // the feed process hasn't reported
  });
});
