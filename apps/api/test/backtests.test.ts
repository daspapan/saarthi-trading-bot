import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCandlesCsv, candleCsvPath, loadBaseEnv, migrate, openDb } from "@saarthi/core";
import { syntheticMarket } from "../../../packages/core/test/synthetic.ts";
import { createApp } from "../src/app.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");
const DAY = 86_400_000;

function setup(withData: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "saarthi-api-bt-"));
  const candlesDir = join(dir, "candles");
  if (withData) {
    for (const [pair, candles] of Object.entries(syntheticMarket())) appendCandlesCsv(candleCsvPath(candlesDir, pair, "15m"), candles);
  }
  const env = loadBaseEnv({ TRADING_MODE: "paper", DB_PATH: join(dir, "t.db"), CONFIG_DIR: CONFIG, CANDLES_DIR: candlesDir });
  const db = openDb(env.dbPath);
  migrate(db);
  return { env, db };
}

async function serve(withData = true) {
  const { env, db } = setup(withData);
  const app = createApp(db, env);
  const server = await new Promise<ReturnType<typeof app.listen>>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, raw?: string) => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json() };
  };
  return { env, db, call, close: () => server.close() };
}

async function waitDone(call: Awaited<ReturnType<typeof serve>>["call"], id: number) {
  for (let i = 0; i < 200; i++) {
    const r = await call("GET", `/backtests/${id}`);
    if (r.body.status !== "running") return r.body;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("backtest never finished");
}

describe("API-02 backtest data and settings", () => {
  it("API-02 /backtests/data with no history explains how to download it", async () => {
    const { call, close } = await serve(false);
    const r = await call("GET", "/backtests/data");
    close();
    expect(r.body.range).toBeNull();
    expect(r.body.hint).toMatch(/npm run candles:download/);
    expect(r.body.files).toHaveLength(6); // 3 pairs x (15m, 1h)
  });

  it("API-02 /backtests/data reports what's on disk and the common date range", async () => {
    const { call, close } = await serve(true);
    const r = await call("GET", "/backtests/data");
    close();
    expect(r.body.hint).toBeNull();
    expect(r.body.range.to - r.body.range.from).toBeGreaterThan(60 * DAY);
    expect(r.body.files.find((f: { pair: string; timeframe: string }) => f.pair === "BTC/USDT" && f.timeframe === "15m").candles).toBe(6_000);
  });

  it("API-02 /settings returns both files with values, ranges and plain help", async () => {
    const { call, close } = await serve(false);
    const r = await call("GET", "/settings");
    close();
    expect(r.body.risk.riskPerTradeBps).toMatchObject({ value: 100, min: 10, max: 200 });
    expect(r.body.strategy["statArb.zEntry"].help).toMatch(/z-score/);
    expect(r.body.strategies.map((s: { id: string }) => s.id)).toEqual(["statArb", "momentum", "meanReversion"]);
  });
});

describe("API-03 backtest requests are checked", () => {
  let api: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    api = await serve(true);
  });
  afterAll(() => api.close());

  it.each([
    [{ strategy: "yolo", from: 0, to: 1 }, /strategy/],
    [{ strategy: "all", from: 10, to: 5 }, /end date must be after the start/],
    [{ strategy: "all", from: 0, to: DAY, overrides: { riskPerTradeBps: 900 } }, /outside the allowed range 10 to 200/],
    [{ strategy: "all", from: 0, to: DAY, overrides: { leverage: 10 } }, /Unknown setting "leverage"/],
    [{ strategy: "all", from: 0, to: DAY, slippageBps: 500 }, /slippageBps/],
    [{ strategy: "all", from: 0, to: DAY, extra: true }, /Invalid request/],
  ])("API-03 %j is refused with a plain reason", async (body, message) => {
    const r = await api.call("POST", "/backtests", body);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(message);
  });

  it("API-03 a body that isn't JSON gets a plain 400, not a stack trace", async () => {
    const r = await api.call("POST", "/backtests", undefined, "{not json");
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "The request body is not valid JSON." });
  });

  it("API-03 an unknown run ID is a 404", async () => {
    expect((await api.call("GET", "/backtests/9999")).status).toBe(404);
    expect((await api.call("GET", "/backtests/abc")).status).toBe(404);
  });
});

describe("API-02 running a backtest end to end (worker thread)", () => {
  it("API-02 POST starts a run (202), a second run is refused while the first works (409), and the result has every section", async () => {
    const { call, close } = await serve(true);
    const data = (await call("GET", "/backtests/data")).body;
    const body = { strategy: "all", from: data.range.from, to: data.range.to, slippageBps: 5, label: "baseline" };
    const [first, second] = await Promise.all([call("POST", "/backtests", body), call("POST", "/backtests", body)]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/still running/);

    const run = await waitDone(call, first.body.id);
    expect(run.status).toBe("done");
    expect(run.label).toBe("baseline");
    expect(run.metrics.trades).toBe(run.totalTrades);
    expect(run.metrics.totalFees).toBeGreaterThan(0);
    expect(run.curve.length).toBeGreaterThan(10);
    expect(run.drawdown.length).toBe(run.curve.length);
    expect(run.benchmark.pair).toBe("BTC/USDT");
    expect(run.walkForward.inSample.days).toBeGreaterThan(run.walkForward.outOfSample.days);
    expect(run.costs).toEqual({ feeBps: 10, slippageBps: 5 });
    expect(run.signalSource).toBe("deterministic");
    expect(run.trades[0]).toEqual(
      expect.objectContaining({ pair: expect.any(String), fees: expect.any(Number), slippage: expect.any(Number), exitReason: expect.any(String) }),
    );

    const list = await call("GET", "/backtests");
    expect(list.body.runs[0]).toMatchObject({ id: first.body.id, status: "done", label: "baseline" });
    expect(list.body.runs[0].summary.trades).toBe(run.metrics.trades);

    // After it finishes, a new run is accepted again.
    const third = await call("POST", "/backtests", { ...body, strategy: "momentum", overrides: { "momentum.minVolumeRatio": 2 } });
    expect(third.status).toBe(202);
    const r3 = await waitDone(call, third.body.id);
    expect(r3.status).toBe("done");
    expect(r3.params.overrides).toEqual({ "momentum.minVolumeRatio": 2 });
    close();
  });

  it("API-03 dates outside the downloaded data fail with a plain message, not a crash", async () => {
    const { call, close } = await serve(true);
    const start = await call("POST", "/backtests", { strategy: "all", from: Date.UTC(2020, 0, 1), to: Date.UTC(2020, 1, 1) });
    const run = await waitDone(call, start.body.id);
    close();
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/less than 7 days of downloaded data/);
  });

  it("API-03 with no history the run fails and says how to download it", async () => {
    const { call, close } = await serve(false);
    const start = await call("POST", "/backtests", { strategy: "all", from: 0, to: 30 * DAY });
    const run = await waitDone(call, start.body.id);
    close();
    expect(run.error).toBe("No historical candles found. Run: npm run candles:download");
  });

  it("API-02 a run left 'running' by a crash is marked failed when the API starts", async () => {
    const { env, db } = setup(false);
    db.prepare("INSERT INTO backtest_runs (strategy, params_json, start_ms, end_ms, status, created_at) VALUES ('all', '{}', 0, 1, 'running', 'x')").run();
    createApp(db, env);
    expect(db.prepare("SELECT status, error FROM backtest_runs").get()).toEqual({
      status: "failed",
      error: "The API restarted while this run was in progress.",
    });
  });
});
