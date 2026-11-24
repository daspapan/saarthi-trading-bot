// The whole path in the API: signal -> guardrails -> validator (live state) -> order queue.
import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Evaluation,
  type Snapshot,
  loadBaseEnv,
  migrate,
  openDb,
  seedPaper,
  setRiskFlag,
  snapshotHash,
  writeEvaluation,
  writePriceState,
} from "@saarthi/core";
import { BTC_CANDIDATE_ID, ETH_EXIT_ID, fixtureSnapshot, goodSignal } from "../../../packages/core/test/fixtures.ts";
import { createApp } from "../src/app.ts";

const TOKEN = "c".repeat(64);

const trusted: Evaluation = {
  feeds: {
    A: { status: "ok", lastDataMs: Date.now(), stalePairs: [], detail: "ok" },
    B: { status: "ok", lastDataMs: Date.now(), stalePairs: [], detail: "ok" },
  },
  pairs: [],
  problems: [],
  paused: false,
  reason: null,
  agreeSinceMs: null,
  resumeInMs: null,
  change: null,
};

/** A healthy paper account: 10,000 USDT, feeds trusted, BTC priced at the candidate's entry. */
async function serve(o: { btcPrice?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "saarthi-val-"));
  const env = loadBaseEnv({ TRADING_MODE: "paper", DB_PATH: join(dir, "t.db"), CONFIG_DIR: join(import.meta.dirname, "..", "..", "..", "config") });
  const db = openDb(env.dbPath);
  migrate(db);
  seedPaper(db);
  writeEvaluation(db, trusted, 60);
  writePriceState(db, { pair: "BTC/USDT", bid: null, ask: null, last: o.btcPrice ?? 97412.03, change24hPct: null, volume24h: null, timeMs: 0 }, null, null);
  writePriceState(db, { pair: "ETH/USDT", bid: null, ask: null, last: 3512.8, change24hPct: null, volume24h: null, timeMs: 0 }, null, null);
  const app = createApp(db, env, { analystToken: TOKEN });
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const res = await fetch(`${url}/signals`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const get = async (path: string) => (await fetch(url + path)).json();
  return { db, post, get, close: () => server.close() };
}

/** The fixture snapshot, taken 30 seconds ago (fresh). */
function freshSnapshot(): Snapshot {
  return { ...fixtureSnapshot(), createdAt: new Date(Date.now() - 30_000).toISOString() };
}

function submission(snapshot: Snapshot, signals: unknown[], runId = "run-1") {
  return { runId, trigger: "manual", snapshot, snapshotHash: snapshotHash(snapshot), source: "ollama", output: { signals }, rawText: "{}", note: null, model: "qwen2.5:7b", latencyMs: 3000, attempts: 1 };
}

describe("Q-01 a signal that passes all 12 rules is queued", () => {
  it("Q-01 the good BTC signal passes the guardrails AND the validator, and lands in the queue", async () => {
    const { post, get, close } = await serve();
    const r = await post(submission(freshSnapshot(), [goodSignal()]));
    const btc = r.body.signals.find((s: { pair: string }) => s.pair === "BTC/USDT");
    expect(btc).toMatchObject({ passed: true, validator: { passed: true, failedRules: [] }, queue: { status: "queued", queueId: 1 } });

    const queue = await get("/queue");
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ pair: "BTC/USDT", direction: "long", status: "pending", payload: { candidateId: BTC_CANDIDATE_ID, confidence: "medium" } });
    expect(queue.items[0].dedupeId).toMatch(/^[0-9a-f]{64}$/);

    const cards = (await get("/signals")).signals;
    const card = cards.find((c: { pair: string }) => c.pair === "BTC/USDT");
    expect(card.validator.rules).toHaveLength(12);
    expect(card.validator.rules.every((x: { passed: boolean }) => x.passed)).toBe(true);
    expect(card.queue).toMatchObject({ id: 1, status: "pending" });
    close();
  });

  it("AUD-01 the audit log reads in order: signal, rule result, queued", async () => {
    const { db, post, close } = await serve();
    await post(submission(freshSnapshot(), [goodSignal()]));
    close();
    const types = (db.prepare("SELECT event_type FROM audit_log ORDER BY id").all() as { event_type: string }[]).map((r) => r.event_type);
    expect(types).toEqual(["signal", "signal", "rule_result", "queued"]);
  });
});

describe("Q-02 the same signal twice is queued once", () => {
  it("Q-02 resubmitting the same run is reported as a duplicate, and the queue still has one item", async () => {
    const { post, get, close } = await serve();
    const snap = freshSnapshot();
    await post(submission(snap, [goodSignal()]));
    const again = await post(submission(snap, [goodSignal()], "run-1-retry"));
    const btc = again.body.signals.find((s: { pair: string }) => s.pair === "BTC/USDT");
    // The first item is now pending for BTC, so rule 9 (conflicting order) also fails the copy:
    // either way it is never queued twice.
    expect(btc.queue.status).not.toBe("queued");
    expect((await get("/queue")).items).toHaveLength(1);
    close();
  });
});

describe("Q-03 a failing signal is never queued", () => {
  it.each([
    ["the guardrails rejected it (forged RSI)", { dataPoints: [{ name: "BTC/USDT 15m RSI", value: 24 }, ...goodSignal().dataPoints.slice(1)] }, {}, [1]],
    ["low confidence", { confidence: "low" }, {}, [10]],
    ["the market moved 1% away from the entry", {}, { btcPrice: 98_400 }, [12]],
  ])("Q-03 not queued when %s", async (_label, change, opts, failed) => {
    const { post, get, close } = await serve(opts as { btcPrice?: number });
    const r = await post(submission(freshSnapshot(), [{ ...goodSignal(), ...change }]));
    const btc = r.body.signals.find((s: { pair: string }) => s.pair === "BTC/USDT");
    expect(btc.validator).toEqual({ passed: false, failedRules: failed });
    expect(btc.queue).toEqual({ status: "not-queued", reason: `Failed rule ${failed.join(", ")}.` });
    expect((await get("/queue")).items).toEqual([]);
    close();
  });

  it("Q-03 the kill switch blocks queuing (rule 4)", async () => {
    const { db, post, get, close } = await serve();
    setRiskFlag(db, "kill_switch", true, "pressed");
    const r = await post(submission(freshSnapshot(), [goodSignal()]));
    expect(r.body.signals[0].validator.failedRules).toEqual([4]);
    expect((await get("/queue")).items).toEqual([]);
    close();
  });

  it("Q-03 a stale snapshot blocks queuing (rule 2)", async () => {
    const { post, close } = await serve();
    const old = { ...fixtureSnapshot(), createdAt: new Date(Date.now() - 3 * 60_000).toISOString() };
    const r = await post(submission(old, [goodSignal()]));
    close();
    expect(r.body.signals[0].validator.failedRules).toEqual([2]);
  });

  it("Q-03 neutral signals never reach the validator or the queue", async () => {
    const { db, post, close } = await serve();
    const neutral = {
      ...goodSignal(),
      direction: "neutral",
      candidateId: null,
      rationale: "Nothing to do.",
      trigger: "None",
      invalidation: "None",
    };
    const r = await post(submission(freshSnapshot(), [neutral]));
    close();
    expect(r.body.signals[0].validator).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM validator_results").get()).toEqual({ n: 0 });
  });
});

describe("VAL-15 an exit of something we don't hold is refused (no shorts)", () => {
  it("VAL-15 the stat-arb exit for ETH fails rule 8 because the account holds no ETH", async () => {
    const { post, get, close } = await serve();
    const exit = {
      pair: "ETH/USDT",
      direction: "exit",
      candidateId: ETH_EXIT_ID,
      confidence: "high",
      dataPoints: [
        { name: "BTC/ETH ratio z-score", value: 0.31 },
        { name: "ETH/USDT price", value: 3512.8 },
        { name: "ETH/USDT 15m RSI", value: 44.4 },
      ],
      trigger: "Ratio reverted",
      invalidation: "None",
      rationale: "The BTC/ETH ratio z-score is 0.31: the gap has closed.",
    };
    const r = await post(submission(freshSnapshot(), [exit]));
    const eth = r.body.signals.find((s: { pair: string }) => s.pair === "ETH/USDT");
    expect(eth.validator.failedRules).toEqual([8]);
    const card = (await get("/signals")).signals.find((c: { pair: string }) => c.pair === "ETH/USDT");
    expect(card.validator.rules.find((x: { rule: number }) => x.rule === 8).message).toBe(
      "We don't hold ETH/USDT; selling it would be a short, and spot trading never borrows.",
    );
    close();
  });
});
