import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  type Candidate,
  type Evaluation,
  type ExchangeClient,
  type ExOrder,
  Executor,
  PaperExchange,
  type QueuePayload,
  applyRules,
  clientIdFor,
  createOrderFromQueue,
  enqueue,
  floorToStep,
  getOrderRow,
  getRiskFlag,
  listQueue,
  loadSettingsFile,
  orderEvents,
  PAPER_RULES,
  reconcile,
  recordEquity,
  roundToTick,
  seedPaper,
  setRiskFlag,
  takeNext,
  writeEvaluation,
  writePriceState,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";

const RISK = loadSettingsFile(join(import.meta.dirname, "..", "..", "..", "config"), "risk.json");
const T0 = Date.UTC(2026, 0, 5, 12, 0, 0);

const LONG: Candidate = {
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

const trusted = (): Evaluation => ({
  feeds: { A: { status: "ok", lastDataMs: 0, stalePairs: [], detail: "" }, B: { status: "ok", lastDataMs: 0, stalePairs: [], detail: "" } },
  pairs: [],
  problems: [],
  paused: false,
  reason: null,
  agreeSinceMs: null,
  resumeInMs: null,
  change: null,
});

/** A paper world with a fake clock and controllable prices. */
function world(o: { client?: (paper: PaperExchange) => ExchangeClient; startPrice?: number } = {}) {
  const { db } = tempDb();
  seedPaper(db);
  const clock = { now: T0 };
  const prices: Record<string, number> = { "BTC/USDT": o.startPrice ?? 100_050 };
  const setPrice = (p: number, pair = "BTC/USDT") => {
    prices[pair] = p;
    writePriceState(db, { pair, bid: null, ask: null, last: p, change24hPct: null, volume24h: null, timeMs: clock.now }, null, null, clock.now);
  };
  setPrice(prices["BTC/USDT"]!);
  const paper = new PaperExchange(db, { price: (p) => prices[p] ?? null, now: () => clock.now });
  const client = o.client ? o.client(paper) : paper;
  const executor = new Executor({ db, client, risk: () => RISK, now: () => clock.now });
  let signalNo = 0;

  /** Queues a candidate as if the validator had approved it. */
  const queue = (c: Candidate = LONG) => {
    signalNo += 1;
    db.prepare("INSERT INTO signals (pair, direction, raw_json, source, created_at) VALUES (?, ?, '{}', 'test', 'x')").run(c.pair, c.direction);
    const payload: QueuePayload = { signalId: signalNo, snapshotHash: "a".repeat(64), pair: c.pair, direction: c.direction, candidateId: `${c.id}-${signalNo}`, confidence: "medium", candidate: c };
    return enqueue(db, payload, { nowMs: clock.now });
  };

  /** One executor second: feeds stay trusted, the paper exchange matches, then the executor ticks. */
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.now += 1_000;
      writeEvaluation(db, trusted(), 60, clock.now);
      paper.process();
      await executor.tick();
    }
  };
  const order = (id = 1) => getOrderRow(db, id);
  const states = (id = 1) => orderEvents(db, id).map((e) => e.toState);
  const alerts = () => (db.prepare("SELECT payload_json FROM audit_log WHERE event_type = 'alert' ORDER BY id").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json) as { level: string; kind: string; message: string });
  const bal = async (asset: string) => (await paper.balances())[asset] ?? { free: 0, locked: 0 };
  return { db, clock, paper, executor, setPrice, queue, tick, order, states, alerts, bal };
}

/** Runs ticks until the order reaches `state` (or fails the test). */
async function until(w: ReturnType<typeof world>, state: string, max = 120, id = 1) {
  for (let i = 0; i < max; i++) {
    if (w.db.prepare("SELECT state FROM orders WHERE id = ?").get(id) && w.order(id).state === state) return;
    await w.tick();
  }
  throw new Error(`order ${id} never reached ${state}; it is ${w.order(id)?.state}`);
}

/** Gets a long position to OPEN: queue, then the price dips through the limit. */
async function toOpen(w: ReturnType<typeof world>) {
  w.queue();
  await until(w, "CONFIRM_FILL");
  w.setPrice(99_990);
  await until(w, "OPEN");
}

describe("EX-01 happy path", () => {
  it("EX-01 QUEUED -> PRECHECK -> PLACE_ENTRY -> CONFIRM_FILL -> PLACE_PROTECTION -> OPEN", async () => {
    const w = world();
    w.queue();
    await w.tick(3);
    expect(w.order().state).toBe("CONFIRM_FILL");
    expect((await w.paper.getOrder("BTC/USDT", w.order().client_order_id))!.status).toBe("open"); // resting limit, not filled yet
    w.setPrice(99_990); // trades through the 100,000 limit
    await w.tick(2);
    expect(w.states()).toEqual(["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "OPEN"]);
    const o = w.order();
    expect(o).toMatchObject({ filled_quantity: 0.025, protection_list_id: `${o.client_order_id}-o` });
    expect(o.avg_fill_price).toBeCloseTo(100_000 * 1.0005, 6);
    expect(listQueue(w.db)[0]!.status).toBe("taken");
    expect(w.db.prepare("SELECT pair, quantity, status FROM positions").all()).toEqual([{ pair: "BTC/USDT", quantity: 0.025, status: "open" }]);
    expect(w.alerts().map((a) => a.kind)).toEqual(["order_filled"]);
  });
});

describe("EX-02 PRECHECK aborts if anything changed", () => {
  it.each([
    ["the kill switch was turned on", (w: ReturnType<typeof world>) => setRiskFlag(w.db, "kill_switch", true, "x"), /kill switch is on/],
    ["a manual restart is required", (w: ReturnType<typeof world>) => setRiskFlag(w.db, "manual_restart", true, "x"), /manual restart/],
    ["the daily loss limit was hit", (w: ReturnType<typeof world>) => setRiskFlag(w.db, "daily_limit_hit", true, "x"), /daily loss limit/],
    ["the price moved 0.5% away", (w: ReturnType<typeof world>) => w.setPrice(100_500), /price moved to 100500/],
    [
      "a position was opened since",
      (w: ReturnType<typeof world>) =>
        w.db.prepare("INSERT INTO positions (pair, quantity, avg_entry, status, opened_at) VALUES ('BTC/USDT', 0.01, 100000, 'open', 'x')").run(),
      /position was opened since the signal/,
    ],
    [
      "cash dropped",
      (w: ReturnType<typeof world>) =>
        w.db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (10000, 1000, 10000, 10000, 'x')").run(),
      /not enough cash now/,
    ],
  ])("EX-02 cancelled when %s, and nothing reaches the exchange", async (_label, change, reason) => {
    const w = world();
    w.queue();
    await w.tick(); // QUEUED -> PRECHECK
    change(w);
    await w.tick();
    expect(w.order().state).toBe("CANCELLED");
    expect(w.order().error).toMatch(reason);
    expect(await w.paper.openOrders()).toEqual([]);
  });
});

describe("EX-03 entry retried 3 times with exponential backoff, then FAILED with an alert", () => {
  it("EX-03 four tries at +0, +1, +2, +4 seconds, then FAILED", async () => {
    const w = world();
    w.paper.injectFault("createOrder", "network", 4);
    w.queue();
    await w.tick(2); // to PLACE_ENTRY
    const tries: number[] = [];
    for (let i = 0; i < 12 && w.order().state === "PLACE_ENTRY"; i++) {
      const before = w.order().attempts;
      await w.tick();
      if (w.order().attempts !== before || w.order().state !== "PLACE_ENTRY") tries.push(w.clock.now);
    }
    expect(w.order().state).toBe("FAILED");
    expect(w.order().error).toMatch(/^Entry failed 4 times: Simulated network/);
    const gaps = tries.slice(1).map((t, i) => (t - tries[i]!) / 1000);
    expect(gaps).toEqual([1, 2, 4]); // backoff doubles
    expect(w.alerts().at(-1)).toMatchObject({ level: "warn", kind: "order_failed" });
  });

  it("EX-03 a non-retryable rejection fails at once, without retries", async () => {
    const w = world();
    w.paper.injectFault("createOrder", "rejected", 1, "Filter failure: PRICE_FILTER");
    w.queue();
    await w.tick(3);
    expect(w.order()).toMatchObject({ state: "FAILED", error: "The exchange refused the order: Filter failure: PRICE_FILTER" });
  });
});

describe("EX-04 / EX-05 unfilled orders are cancelled on time", () => {
  it("EX-04 an unfilled limit order is cancelled after 60 seconds, and the locked cash is released", async () => {
    const w = world();
    w.queue();
    await until(w, "CONFIRM_FILL");
    expect((await w.bal("USDT")).locked).toBeGreaterThan(2_500);
    await w.tick(59);
    expect(w.order().state).toBe("CONFIRM_FILL");
    await w.tick(1);
    expect(w.order()).toMatchObject({ state: "CANCELLED", error: "Not filled within 60 s, so it was cancelled." });
    expect((await w.paper.getOrder("BTC/USDT", w.order().client_order_id))!.status).toBe("canceled");
    expect(await w.bal("USDT")).toEqual({ free: 10_000, locked: 0 });
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 0 });
  });

  it("EX-05 an unfilled market order is cancelled after 10 seconds", async () => {
    const cancelled: string[] = [];
    const stuck = (o: Partial<ExOrder>): ExOrder => ({ id: "1", clientOrderId: "x", pair: "ETH/USDT", side: "sell", type: "market", price: null, quantity: 0.5, filled: 0, avgPrice: null, status: "open", fee: 0, ...o });
    let status: ExOrder["status"] = "open";
    const w = world({
      client: (paper) => ({
        ...paper,
        name: "paper",
        rules: (p) => paper.rules(p),
        balances: async () => ({ USDT: { free: 10_000, locked: 0 }, ETH: { free: 0.5, locked: 0 } }),
        openOrders: async () => [],
        getOco: async () => null,
        cancelOco: async () => {},
        ping: async () => {},
        createOco: (r) => paper.createOco(r),
        getOrder: async (_p, id) => (id.endsWith("-x") ? null : cancelled.length || status !== "open" ? stuck({ clientOrderId: id, status }) : id.startsWith("sa") && w2 ? stuck({ clientOrderId: id }) : null),
        createOrder: async (r) => {
          w2 = true;
          return stuck({ clientOrderId: r.clientOrderId });
        },
        cancelOrder: async (_p, id) => {
          cancelled.push(id);
          status = "canceled";
          return stuck({ clientOrderId: id, status });
        },
      }),
    });
    let w2 = false;
    w.setPrice(3_000, "ETH/USDT");
    w.db.prepare("INSERT INTO positions (pair, quantity, avg_entry, status, opened_at) VALUES ('ETH/USDT', 0.5, 2900, 'open', 'x')").run();
    w.queue({ id: "statArb-exit-ETHUSDT-1", strategy: "statArb", pair: "ETH/USDT", direction: "exit", price: 3_000, quantity: 0.5, score: 1, reason: "r", dataPoints: [] });
    await until(w, "CONFIRM_FILL");
    await w.tick(9);
    expect(w.order().state).toBe("CONFIRM_FILL");
    await w.tick(1);
    expect(cancelled).toHaveLength(1);
    expect(w.order()).toMatchObject({ state: "CANCELLED", error: "Not filled within 10 s, so it was cancelled." });
  });
});

describe("EX-06 a partial fill protects what filled and cancels the rest", () => {
  it("EX-06 40% filled at the 60 s timeout: rest cancelled, OCO for exactly the filled 0.01 BTC", async () => {
    const w = world();
    w.queue();
    await until(w, "CONFIRM_FILL");
    w.paper.partialFillNext(0.4);
    w.setPrice(99_990);
    await w.tick(); // 40% fills
    w.setPrice(100_050); // then the price runs away: no more fills
    await w.tick();
    expect(w.order().state).toBe("CONFIRM_FILL"); // partly filled, still working
    await until(w, "OPEN");
    const o = w.order();
    expect(o.filled_quantity).toBeCloseTo(0.01, 12);
    const oco = (await w.paper.getOco("BTC/USDT", o.protection_list_id!))!;
    expect(oco.stop.quantity).toBeCloseTo(0.01, 12);
    expect((await w.paper.getOrder("BTC/USDT", o.client_order_id))!.status).toBe("canceled");
    expect(orderEvents(w.db, 1).find((e) => e.toState === "PLACE_PROTECTION")!.detail).toMatch(/Partly filled: protecting the 0\.01/);
  });
});

describe("EX-07 the OCO uses the right prices and the filled quantity", () => {
  it("EX-07 stop 99,400 (limit 0.5% below), target 101,200, quantity = filled", async () => {
    const w = world();
    await toOpen(w);
    const oco = (await w.paper.getOco("BTC/USDT", w.order().protection_list_id!))!;
    expect(oco.stop).toMatchObject({ type: "stop_loss_limit", side: "sell", quantity: 0.025, price: roundToTick(99_400 * 0.995, 0.01) });
    expect(w.paper["db"].prepare("SELECT stop_price FROM paper_orders WHERE client_order_id = ?").get(oco.stop.clientOrderId)).toEqual({ stop_price: 99_400 });
    expect(oco.takeProfit).toMatchObject({ type: "limit_maker", side: "sell", quantity: 0.025, price: 101_200 });
    expect(await w.bal("BTC")).toEqual({ free: 0, locked: 0.025 }); // the coins are locked by the OCO
  });
});

describe("EX-08 OCO failure: emergency close, alert, kill switch", () => {
  it("EX-08 the position is sold at market at once, the kill switch is set, pending orders are discarded", async () => {
    const w = world();
    w.paper.injectFault("createOco", "rejected", 5, "OCO rejected");
    w.queue();
    w.queue({ ...LONG, id: "momentum-long-ETHUSDT-9", pair: "ETH/USDT", entry: 3_000, stop: 2_970, target: 3_060, quantity: 0.8, notional: 2_400, riskAmount: 24, atr: 20 });
    await until(w, "CONFIRM_FILL");
    w.setPrice(99_990);
    await until(w, "CLOSED");
    expect(w.states()).toEqual(["QUEUED", "PRECHECK", "PLACE_ENTRY", "CONFIRM_FILL", "PLACE_PROTECTION", "EMERGENCY_CLOSE", "CLOSED"]);
    expect(w.order()).toMatchObject({ close_reason: "emergency" });
    expect(getRiskFlag(w.db, "kill_switch")).toEqual({ active: true, reason: "Protective stop for BTC/USDT could not be placed: OCO rejected" });
    expect(w.alerts().filter((a) => a.level === "critical").map((a) => a.kind)).toEqual(["protection_failed", "emergency_closed"]);
    expect(await w.bal("BTC")).toEqual({ free: 0, locked: 0 }); // nothing left unprotected
    expect(w.db.prepare("SELECT status FROM positions").all()).toEqual([{ status: "closed" }]);
  });

  it("EX-08 a retryable OCO error gets one more try before the emergency", async () => {
    const w = world();
    w.paper.injectFault("createOco", "network", 1);
    await toOpen(w);
    expect(w.states()).not.toContain("EMERGENCY_CLOSE");
  });
});

describe("EX-09 the emergency close never fails silently", () => {
  it("EX-09 it keeps retrying with backoff, a critical alert every time, and never gives up", async () => {
    const w = world();
    w.paper.injectFault("createOco", "rejected", 5);
    w.queue();
    await until(w, "CONFIRM_FILL");
    w.paper.injectFault("createOrder", "network", 6, "Exchange unreachable");
    w.setPrice(99_990);
    await until(w, "EMERGENCY_CLOSE");
    await w.tick(40);
    expect(w.order().state).toBe("EMERGENCY_CLOSE"); // still trying, never FAILED
    const failures = w.alerts().filter((a) => a.kind === "emergency_close_failed");
    expect(failures.length).toBe(6); // tries at +0, +1, +3, +7, +15, +31 s
    expect(w.order().attempts).toBe(6);
    expect(failures.every((a) => a.level === "critical" && /UNPROTECTED/.test(a.message))).toBe(true);
    await until(w, "CLOSED", 60);
    expect(w.order().close_reason).toBe("emergency");
  });
});

describe("EX-10 the state is saved after every step", () => {
  it("EX-10 after each tick the saved state, the events and the audit log agree", async () => {
    const w = world();
    w.queue();
    for (let i = 0; i < 6; i++) {
      if (i === 3) w.setPrice(99_990);
      await w.tick();
      const events = orderEvents(w.db, 1);
      expect(events.at(-1)!.toState).toBe(w.order().state);
      const audited = w.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = 'order_state'").get() as { n: number };
      expect(audited.n).toBe(events.length);
      for (let k = 1; k < events.length; k++) expect(events[k]!.fromState).toBe(events[k - 1]!.toState);
    }
    expect(w.order().state).toBe("OPEN");
  });
});

describe("EX-11 a crash in any state resumes correctly", () => {
  type Crash = { at: string; before?: (w: ReturnType<typeof world>) => Promise<void> };
  const cases: Crash[] = [
    { at: "QUEUED" },
    { at: "PRECHECK" },
    { at: "PLACE_ENTRY" },
    // The order reached the exchange but we crashed before saving that.
    { at: "PLACE_ENTRY", before: async (w) => void (await w.paper.createOrder({ pair: "BTC/USDT", side: "buy", type: "limit", quantity: 0.025, price: 100_000, clientOrderId: w.order().client_order_id })) },
    { at: "CONFIRM_FILL" },
    { at: "PLACE_PROTECTION" },
    // The OCO reached the exchange but we crashed before saving that.
    {
      at: "PLACE_PROTECTION",
      before: async (w) => {
        const id = w.order().client_order_id;
        await w.paper.createOco({ pair: "BTC/USDT", quantity: 0.025, stopPrice: 99_400, stopLimitPrice: 98_903, takeProfitPrice: 101_200, clientListId: `${id}-o`, stopClientOrderId: `${id}-s`, takeProfitClientOrderId: `${id}-t` });
      },
    },
    { at: "OPEN" },
  ];

  it.each(cases.map((c, i) => [`${c.at}${c.before ? " (after the exchange call, before saving)" : ""}`, i] as const))(
    "EX-11 crash in %s: a new executor resumes to OPEN with exactly one entry and one OCO",
    async (_label, i) => {
      const c = cases[i]!;
      const w = world();
      w.queue();
      // A crash right after the queue item became an order, before any work on it.
      if (c.at === "QUEUED") createOrderFromQueue(w.db, takeNext(w.db, w.clock.now)!, w.clock.now);
      // Drive the first executor until the crash point. Price dips once the order is resting.
      for (let k = 0; k < 120 && w.db.prepare("SELECT state FROM orders").get() === undefined; k++) await w.tick();
      for (let k = 0; k < 120 && w.order().state !== c.at; k++) {
        if (w.order().state === "CONFIRM_FILL") w.setPrice(99_990);
        if (c.at === "PLACE_PROTECTION" || c.at === "OPEN") w.setPrice(99_990);
        // Step manually so we can stop exactly before the target state's work.
        w.clock.now += 1_000;
        writeEvaluation(w.db, trusted(), 60, w.clock.now);
        w.paper.process();
        await w.executor.tick();
      }
      expect(w.order().state).toBe(c.at);
      await c.before?.(w);

      // "Crash": the old executor is gone. Start a fresh one, reconcile first, then run.
      const fresh = new Executor({ db: w.db, client: w.paper, risk: () => RISK, now: () => w.clock.now });
      await reconcile(w.db, w.paper, w.clock.now);
      w.setPrice(99_990);
      for (let k = 0; k < 30 && w.order().state !== "OPEN"; k++) {
        w.clock.now += 1_000;
        writeEvaluation(w.db, trusted(), 60, w.clock.now);
        w.paper.process();
        await fresh.tick();
      }
      expect(w.order().state).toBe("OPEN");
      const exOrders = w.paper["db"].prepare("SELECT client_order_id, type FROM paper_orders ORDER BY id").all() as { client_order_id: string; type: string }[];
      expect(exOrders.filter((r) => r.type === "limit")).toHaveLength(1);
      expect(exOrders.filter((r) => r.type === "stop_loss_limit")).toHaveLength(1);
      expect(w.db.prepare("SELECT COUNT(*) AS n FROM positions").get()).toEqual({ n: 1 });
    },
  );

  it("EX-11 a crash during EMERGENCY_CLOSE resumes the sale (and doesn't sell twice)", async () => {
    const w = world();
    w.paper.injectFault("createOco", "rejected", 5);
    w.queue();
    await until(w, "CONFIRM_FILL");
    w.setPrice(99_990);
    await until(w, "EMERGENCY_CLOSE");
    const fresh = new Executor({ db: w.db, client: w.paper, risk: () => RISK, now: () => w.clock.now });
    await reconcile(w.db, w.paper, w.clock.now);
    for (let k = 0; k < 10 && w.order().state !== "CLOSED"; k++) {
      w.clock.now += 1_000;
      await fresh.tick();
    }
    expect(w.order().state).toBe("CLOSED");
    const sells = w.paper["db"].prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE side = 'sell' AND type = 'market'").get() as { n: number };
    expect(sells.n).toBe(1);
  });
});

describe("EX-12 reconciliation on start", () => {
  it("EX-12 an order the exchange has but the database doesn't is cancelled and audited", async () => {
    const w = world();
    await w.paper.createOrder({ pair: "BTC/USDT", side: "buy", type: "limit", quantity: 0.001, price: 90_000, clientOrderId: "manual-order-1" });
    const report = await reconcile(w.db, w.paper, w.clock.now);
    expect(report.orphansCancelled).toEqual(["manual-order-1"]);
    expect((await w.paper.getOrder("BTC/USDT", "manual-order-1"))!.status).toBe("canceled");
    expect(w.db.prepare("SELECT payload_json FROM audit_log WHERE event_type = 'reconcile' ORDER BY id LIMIT 1").get()).toMatchObject({
      payload_json: expect.stringContaining('"kind":"orphan_cancelled"'),
    });
  });

  it("EX-12 testnet reset: an order the database waits on but the exchange never saw is cancelled", async () => {
    const w = world();
    w.queue();
    await until(w, "CONFIRM_FILL");
    w.paper["db"].exec("DELETE FROM paper_orders"); // the exchange forgot everything
    const report = await reconcile(w.db, w.paper, w.clock.now);
    expect(report.ordersCancelled).toEqual([1]);
    expect(w.order()).toMatchObject({ state: "CANCELLED" });
    expect(orderEvents(w.db, 1).at(-1)!.detail).toMatch(/no record of this order \(testnet reset\?\)/);
  });

  it("EX-12 testnet reset: a position whose coins are gone is closed as 'reconciled'", async () => {
    const w = world();
    await toOpen(w);
    w.paper["db"].exec("DELETE FROM paper_orders; UPDATE paper_balances SET free = 10000, locked = 0 WHERE asset = 'USDT'; DELETE FROM paper_balances WHERE asset = 'BTC';");
    const report = await reconcile(w.db, w.paper, w.clock.now);
    expect(report.positionsClosed).toEqual([1]);
    expect(w.order()).toMatchObject({ state: "CLOSED", close_reason: "reconciled", realised_pnl: null });
    expect(w.db.prepare("SELECT status FROM positions").get()).toEqual({ status: "closed" });
  });

  it("EX-12 coins still held but the stop is gone: protected again", async () => {
    const w = world();
    await toOpen(w);
    await w.paper.cancelOco("BTC/USDT", w.order().protection_list_id!);
    w.paper["db"].exec("DELETE FROM paper_orders WHERE list_client_id IS NOT NULL"); // the OCO vanished
    const report = await reconcile(w.db, w.paper, w.clock.now);
    expect(report.reprotected).toEqual([1]);
    await w.tick(2);
    expect(w.order().state).toBe("OPEN");
    expect((await w.paper.getOco("BTC/USDT", w.order().protection_list_id!))!.status).toBe("open");
  });
});

describe("EX-13 the client order ID is the dedupe ID, so a retry can never place twice", () => {
  it("EX-13 client order ID = 'sa' + the first 30 characters of the queue's dedupe ID (36-character exchange limit)", async () => {
    const w = world();
    const q = w.queue();
    await until(w, "CONFIRM_FILL");
    expect(w.order().client_order_id).toBe(clientIdFor(q.dedupeId));
    expect(w.order().client_order_id).toBe(`sa${q.dedupeId.slice(0, 30)}`);
    expect(w.order().client_order_id.length).toBeLessThanOrEqual(36);
    expect(await w.paper.getOrder("BTC/USDT", w.order().client_order_id)).not.toBeNull();
  });

  it("EX-13 the exchange took the order but the reply was lost: the retry adopts it instead of placing a second", async () => {
    let calls = 0;
    const w = world({
      client: (paper) =>
        Object.assign(Object.create(Object.getPrototypeOf(paper)), paper, {
          createOrder: async (r: Parameters<PaperExchange["createOrder"]>[0]) => {
            calls += 1;
            await paper.createOrder(r); // it DID reach the exchange...
            throw new Error("socket hang up"); // ...but the answer never came back
          },
        }),
    });
    w.queue();
    await w.tick(10);
    expect(calls).toBe(1);
    expect(w.order().state).toBe("CONFIRM_FILL");
    expect(w.paper["db"].prepare("SELECT COUNT(*) AS n FROM paper_orders").get()).toEqual({ n: 1 });
  });

  it("EX-13 the exchange itself refuses a reused client order ID", async () => {
    const w = world();
    const r = { pair: "BTC/USDT", side: "buy" as const, type: "limit" as const, quantity: 0.001, price: 90_000, clientOrderId: "sa-same" };
    await w.paper.createOrder(r);
    await expect(w.paper.createOrder(r)).rejects.toThrow(/Duplicate order/);
  });
});

describe("EX-14 / EX-15 target or stop hit: CLOSED with P&L after fees", () => {
  it("EX-14 target hit: P&L = (exit - entry) x quantity - entry fee - exit fee", async () => {
    const w = world();
    await toOpen(w);
    w.setPrice(101_300);
    await w.tick(2);
    const o = w.order();
    expect(o).toMatchObject({ state: "CLOSED", close_reason: "target" });
    const entry = 100_000 * 1.0005;
    const exit = 101_200 * 0.9995;
    const expected = (exit - entry) * 0.025 - entry * 0.025 * 0.001 - exit * 0.025 * 0.001;
    expect(o.realised_pnl!).toBeCloseTo(expected, 6);
    expect(o.realised_pnl!).toBeGreaterThan(0);
    expect(w.db.prepare("SELECT status, realised_pnl FROM positions").get()).toEqual({ status: "closed", realised_pnl: o.realised_pnl });
    expect(w.alerts().at(-1)).toMatchObject({ kind: "target_hit" });
    // Cash after: 10,000 + P&L exactly (nothing left locked).
    expect((await w.bal("USDT")).free).toBeCloseTo(10_000 + expected, 6);
    expect(await w.bal("BTC")).toEqual({ free: 0, locked: 0 });
  });

  it("EX-15 stop hit: a loss, including both fees, and a 'stop hit' alert", async () => {
    const w = world();
    await toOpen(w);
    w.setPrice(99_300);
    await w.tick(2);
    const o = w.order();
    expect(o).toMatchObject({ state: "CLOSED", close_reason: "stop" });
    const entry = 100_000 * 1.0005;
    const exit = 99_300 * 0.9995; // a gap below the stop fills at the market, not at the stop
    const expected = (exit - entry) * 0.025 - entry * 0.025 * 0.001 - exit * 0.025 * 0.001;
    expect(o.realised_pnl!).toBeCloseTo(expected, 6);
    expect(w.alerts().at(-1)).toMatchObject({ level: "warn", kind: "stop_hit" });
  });
});

describe("EX-16 exchange rounding and minimums", () => {
  const BTC = PAPER_RULES["BTC/USDT"]!;

  it("EX-16 quantity rounds DOWN to the lot size, price to the nearest tick", () => {
    expect(floorToStep(0.0253456789, BTC.stepSize)).toBe(0.02534);
    expect(floorToStep(0.00003, BTC.stepSize)).toBe(0.00003); // no floating-point drift
    expect(roundToTick(100_000.004, BTC.tickSize)).toBe(100_000);
    expect(roundToTick(98_902.995, BTC.tickSize)).toBe(98_903);
    expect(applyRules(BTC, 0.0253456789, 100_000.004, 100_000)).toEqual({ ok: true, quantity: 0.02534, price: 100_000 });
  });

  it("EX-16 an order below the minimum value or quantity is refused with the reason", () => {
    expect(applyRules(BTC, 0.00004, 100_000, 100_000)).toEqual({ ok: false, reason: "Order value 4.00 USDT is below the exchange minimum of 5 USDT." });
    expect(applyRules(BTC, 0.000001, 100_000, 100_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/below the exchange minimum of 0\.00001 BTC/) });
  });

  it("EX-16 the executor sends rounded numbers and fails a too-small order before calling the exchange", async () => {
    const w = world();
    w.queue({ ...LONG, quantity: 0.0253456789, entry: 100_000.004 });
    await until(w, "CONFIRM_FILL");
    expect(w.order()).toMatchObject({ quantity: 0.02534, entry_price: 100_000 });

    const w2 = world();
    w2.queue({ ...LONG, quantity: 0.00004, notional: 4 });
    await w2.tick(3);
    expect(w2.order()).toMatchObject({ state: "FAILED", error: "Order value 4.00 USDT is below the exchange minimum of 5 USDT." });
    expect(await w2.paper.openOrders()).toEqual([]);
  });
});

describe("EX-17 / EX-18 balance and rate limits", () => {
  it("EX-17 not enough balance on the exchange: FAILED with a plain reason, no retries", async () => {
    const w = world();
    w.paper["db"].exec("UPDATE paper_balances SET free = 100 WHERE asset = 'USDT'");
    w.queue();
    await w.tick(3);
    expect(w.order().state).toBe("FAILED");
    expect(w.order().error).toMatch(/^Not enough balance on the exchange: Not enough USDT: need 2502\.5/);
  });

  it("EX-18 HTTP 429 backs off and retries, then succeeds", async () => {
    const w = world();
    w.paper.injectFault("createOrder", "rate_limit", 2, "HTTP 429 Too Many Requests");
    w.queue();
    await w.tick(3);
    expect(w.order()).toMatchObject({ state: "PLACE_ENTRY", attempts: 1, error: "HTTP 429 Too Many Requests" });
    await w.tick(6);
    expect(w.order().state).toBe("CONFIRM_FILL");
  });
});

describe("Exits: stat-arb sells what it bought", () => {
  it("STR-07 an exit cancels the position's OCO, sells at market, and closes both orders with P&L", async () => {
    const w = world();
    await toOpen(w);
    w.setPrice(100_600);
    w.queue({ id: "statArb-exit-BTCUSDT-1", strategy: "statArb", pair: "BTC/USDT", direction: "exit", price: 100_600, quantity: 0.025, score: 1, reason: "r", dataPoints: [] });
    await until(w, "CLOSED", 20, 2);
    expect(w.order(2)).toMatchObject({ direction: "exit", close_reason: "exit-signal" });
    expect(w.order(1)).toMatchObject({ state: "CLOSED", close_reason: "exit-signal" });
    expect(w.order(1).realised_pnl).toBe(w.order(2).realised_pnl);
    expect((await w.paper.getOco("BTC/USDT", w.order(1).protection_list_id!))!.stop.status).toBe("canceled");
    expect(await w.bal("BTC")).toEqual({ free: 0, locked: 0 });
  });

  it("STR-07 an exit with nothing to sell is cancelled in PRECHECK", async () => {
    const w = world();
    w.queue({ id: "statArb-exit-BTCUSDT-2", strategy: "statArb", pair: "BTC/USDT", direction: "exit", price: 100_000, quantity: 0.01, score: 1, reason: "r", dataPoints: [] });
    await w.tick(2);
    expect(w.order()).toMatchObject({ state: "CANCELLED", error: "there is no BTC/USDT position to sell any more." });
  });
});

describe("Equity snapshots from real balances", () => {
  it("RISK-01 equity = USDT + coins at current prices; high-water mark and start-of-day equity kept", async () => {
    const w = world();
    await toOpen(w);
    w.setPrice(101_000);
    const e = await recordEquity(w.db, w.paper, ["BTC/USDT"], { "BTC/USDT": 101_000 }, w.clock.now);
    const usdt = await w.bal("USDT");
    expect(e.equity).toBeCloseTo(usdt.free + usdt.locked + 0.025 * 101_000, 6);
    expect(e.cash).toBe(usdt.free);
    expect(e.highWaterMark).toBe(Math.max(10_000, e.equity));
    expect(e.dayStartEquity).toBe(10_000);
    const next = await recordEquity(w.db, w.paper, ["BTC/USDT"], { "BTC/USDT": 99_500 }, w.clock.now + 86_400_000);
    expect(next.dayStartEquity).toBeCloseTo(e.equity, 6); // a new UTC day starts from yesterday's last equity
    expect(next.highWaterMark).toBeCloseTo(e.highWaterMark, 6);
  });
});

describe("Edge cases while a position is open", () => {
  it("EX-07 an OCO cancelled by hand on the exchange is placed again, with a warning", async () => {
    const w = world();
    await toOpen(w);
    const first = w.order().protection_list_id!;
    await w.paper.cancelOco("BTC/USDT", first);
    await w.tick(3);
    expect(w.order().state).toBe("OPEN");
    expect(w.states().slice(-2)).toEqual(["PLACE_PROTECTION", "OPEN"]);
    expect(w.alerts().some((a) => a.kind === "protection_missing")).toBe(true);
    expect(await w.bal("BTC")).toEqual({ free: 0, locked: 0.025 }); // protected again
    // The exchange never reuses a client ID, so the new OCO is generation 2.
    expect(w.order().protection_list_id).toBe(`${first}2`);
    expect(getRiskFlag(w.db, "kill_switch").active).toBe(false);
  });

  it("EX-09 emergency close when the coins were already sold by hand: closed as flat, no sale attempted", async () => {
    const w = world();
    w.paper.injectFault("createOco", "rejected", 5);
    w.queue();
    await until(w, "CONFIRM_FILL");
    w.setPrice(99_990);
    w.paper.process();
    // Someone sells the coins by hand before the executor notices the fill.
    w.paper["db"].exec("UPDATE paper_balances SET free = 0 WHERE asset = 'BTC'");
    await until(w, "CLOSED");
    expect(orderEvents(w.db, 1).at(-1)!.detail).toBe("Nothing left to sell: the position is already flat.");
    expect(w.paper["db"].prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE type = 'market'").get()).toEqual({ n: 0 });
  });
});

describe("Paper exchange matching", () => {
  it("PAPER-01 a limit order only fills when the price trades THROUGH it, with slippage and a fee", async () => {
    const w = world();
    await w.paper.createOrder({ pair: "BTC/USDT", side: "buy", type: "limit", quantity: 0.01, price: 100_000, clientOrderId: "b1" });
    w.setPrice(100_000); // touching is not enough
    w.paper.process();
    expect((await w.paper.getOrder("BTC/USDT", "b1"))!.status).toBe("open");
    w.setPrice(99_999.99);
    w.paper.process();
    const o = (await w.paper.getOrder("BTC/USDT", "b1"))!;
    expect(o).toMatchObject({ status: "filled", filled: 0.01 });
    expect(o.avgPrice).toBeCloseTo(100_000 * 1.0005, 6);
    expect(o.fee).toBeCloseTo(o.avgPrice! * 0.01 * 0.001, 9);
    expect(await w.bal("BTC")).toEqual({ free: 0.01, locked: 0 });
  });

  it("PAPER-01 a market sell without the coins is refused as insufficient balance", async () => {
    const w = world();
    await expect(w.paper.createOrder({ pair: "BTC/USDT", side: "sell", type: "market", quantity: 0.01, clientOrderId: "s1" })).rejects.toMatchObject({
      kind: "insufficient_balance",
    });
  });

  it("PAPER-01 cancelling a filled order is refused; an unknown one is not_found", async () => {
    const w = world();
    await w.paper.createOrder({ pair: "BTC/USDT", side: "buy", type: "market", quantity: 0.001, clientOrderId: "m1" });
    expect((await w.paper.cancelOrder("BTC/USDT", "m1")).status).toBe("filled"); // nothing to cancel, state unchanged
    await expect(w.paper.cancelOrder("BTC/USDT", "nope")).rejects.toMatchObject({ kind: "not_found" });
  });
});
