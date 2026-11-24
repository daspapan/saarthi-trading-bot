import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigError,
  appendCandlesCsv,
  candleCsvPath,
  createRunRecord,
  executeBacktestRun,
  getRun,
  listRuns,
  loadHistoryUrl,
  prepareBacktestRequest,
} from "../src/index.ts";
import { tempDb } from "./helpers.ts";
import { syntheticMarket } from "./synthetic.ts";

const CONFIG = join(import.meta.dirname, "..", "..", "..", "config");

function withHistory() {
  const dir = mkdtempSync(join(tmpdir(), "saarthi-runs-"));
  const market = syntheticMarket();
  for (const [pair, candles] of Object.entries(market)) appendCandlesCsv(candleCsvPath(dir, pair, "15m"), candles);
  const first = market["BTC/USDT"][0]!.openTimeMs;
  const last = market["BTC/USDT"].at(-1)!.openTimeMs;
  return { dir, from: first, to: last + 900_000 };
}

describe("BT-01 stored backtest runs", () => {
  it("BT-01 a run is saved with metrics, curves, walk-forward, and every trade", () => {
    const { db } = tempDb();
    const { dir, from, to } = withHistory();
    const body = { strategy: "all", from, to, label: "test" };
    const prepared = prepareBacktestRequest(body, CONFIG);
    if (!prepared.ok) throw new Error(prepared.error);
    const id = createRunRecord(db, prepared.request);
    expect(listRuns(db)[0]).toMatchObject({ id, status: "running", summary: null });

    executeBacktestRun(db, id, body, CONFIG, dir);
    const run = getRun(db, id)!;
    expect(run.status).toBe("done");
    expect(run.totalTrades).toBe((run.metrics as { trades: number }).trades);
    expect(run).toHaveProperty("walkForward.splitTime");
    expect(run).toHaveProperty("benchmark.pair", "BTC/USDT");
    expect(listRuns(db)[0]!.summary!.trades).toBe(run.totalTrades);
  });

  it("BT-01 a bad request saved as a run fails with its reason instead of crashing", () => {
    const { db } = tempDb();
    const id = createRunRecord(db, { strategy: "all", from: 0, to: 1, slippageBps: 5, overrides: {} });
    executeBacktestRun(db, id, { strategy: "all", from: 0, to: 1, overrides: { riskPerTradeBps: 5000 } }, CONFIG, "/nowhere");
    expect(getRun(db, id)).toMatchObject({ status: "failed", error: expect.stringMatching(/outside the allowed range/) });
    expect(getRun(db, 999)).toBeNull();
  });

  it("BT-01 overrides go to whichever file owns the key, risk or strategy", () => {
    const r = prepareBacktestRequest({ strategy: "momentum", from: 0, to: 1, overrides: { "momentum.targetR": 3, maxTradesPerDay: 2 } }, CONFIG);
    expect(r.ok && r.strategy["momentum.targetR"]?.value).toBe(3);
    expect(r.ok && r.risk.maxTradesPerDay?.value).toBe(2);
    expect(prepareBacktestRequest({ strategy: "all", from: 0, to: 1, overrides: { "statArb.enabled": "yes" } }, CONFIG)).toEqual({
      ok: false,
      error: "statArb.enabled must be true or false.",
    });
  });
});

describe("BT-09 history downloads only from the market-data host", () => {
  it("BT-09 data-api.binance.vision is allowed (and is the default)", () => {
    expect(loadHistoryUrl({})).toBe("https://data-api.binance.vision");
    expect(loadHistoryUrl({ HISTORY_BASE_URL: "https://data-api.binance.vision" })).toBe("https://data-api.binance.vision");
  });

  it.each(["https://api.binance.com", "https://testnet.binance.vision", "http://data-api.binance.vision", "nonsense"])(
    "BT-09 %s is refused (only the market-data-only host may be used)",
    (url) => {
      expect(() => loadHistoryUrl({ HISTORY_BASE_URL: url })).toThrow(ConfigError);
    },
  );
});
