// A small hand-built snapshot for guardrail tests: BTC and ETH, one momentum
// candidate on BTC and one stat-arb exit on ETH.
import type { Snapshot } from "../src/index.ts";

export const BTC_CANDIDATE_ID = "momentum-long-BTCUSDT-1767225600000";
export const ETH_EXIT_ID = "statArb-exit-ETHUSDT-1767225600000";

export function fixtureSnapshot(): Snapshot {
  return {
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    mode: "paper",
    pairs: [
      {
        pair: "BTC/USDT",
        price: { last: 97412.03, bid: 97410.5, ask: 97413.1, change24hPct: 1.84, volume24h: 1520.4 },
        m15: { rsi: 61.25, macd: 120.5, macdSignal: 80.25, macdHistogram: 40.25, bollingerUpper: 98100, bollingerMiddle: 97000.5, bollingerLower: 95900, bandWidthPct: 2.27, atr: 410.5, volumeRatio: 1.84 },
        h4: { rsi: 58.1, macd: 300, macdSignal: 220, macdHistogram: 80, bollingerUpper: 99000, bollingerMiddle: 95500, bollingerLower: 92000, bandWidthPct: 7.33, atr: 1200, volumeRatio: 1.1 },
      },
      {
        pair: "ETH/USDT",
        price: { last: 3512.8, bid: 3512.5, ask: 3513.1, change24hPct: -0.92, volume24h: 9876.5 },
        m15: { rsi: 44.4, macd: -2.5, macdSignal: -1.75, macdHistogram: -0.75, bollingerUpper: 3560, bollingerMiddle: 3530, bollingerLower: 3500, bandWidthPct: 1.7, atr: 14.2, volumeRatio: 0.95 },
        h4: null,
      },
    ],
    ratio: { z: 0.31, ratio: 27.7303, mean: 27.6891 },
    account: { equity: 10000, cash: 9000, exposurePct: 10, positions: [{ pair: "ETH/USDT", quantity: 0.2847, avgEntry: 3480, value: 1000.09, unrealisedPnl: 9.34 }] },
    today: { trades: 1, pnl: 0, dailyLossLimitUsdt: 200, dailyLossUsedPct: 0 },
    strategy: { "momentum.enabled": true },
    candidates: [
      {
        id: BTC_CANDIDATE_ID,
        strategy: "momentum",
        pair: "BTC/USDT",
        direction: "long",
        entry: 97412.03,
        stop: 96796.28,
        target: 98643.53,
        rewardToRisk: 2,
        stopAtr: 1.5,
        atr: 410.5,
        quantity: 0.025664,
        notional: 2499.98,
        riskAmount: 15.8,
        score: 0.42,
        reason: "trend",
        dataPoints: [
          { name: "BTC/USDT price", value: 97412.03 },
          { name: "BTC/USDT 15m RSI", value: 61.25 },
          { name: "BTC/USDT 15m volume vs 30d avg", value: 1.84 },
          { name: "BTC/USDT 4h MACD histogram", value: 80 },
          { name: "BTC/USDT 15m ATR", value: 410.5 },
        ],
      },
      {
        id: ETH_EXIT_ID,
        strategy: "statArb",
        pair: "ETH/USDT",
        direction: "exit",
        price: 3512.8,
        quantity: 0.2847,
        score: 1,
        reason: "reverted",
        dataPoints: [{ name: "BTC/ETH ratio z-score", value: 0.31 }],
      },
    ],
    skipped: [],
    facts: [
      { name: "BTC/USDT price", value: 97412.03 },
      { name: "BTC/USDT 24h change %", value: 1.84 },
      { name: "BTC/USDT 15m RSI", value: 61.25 },
      { name: "BTC/USDT 15m volume vs 30d avg", value: 1.84 },
      { name: "BTC/USDT 4h MACD histogram", value: 80 },
      { name: "BTC/USDT 15m ATR", value: 410.5 },
      { name: "ETH/USDT price", value: 3512.8 },
      { name: "ETH/USDT 15m RSI", value: 44.4 },
      { name: "BTC/ETH ratio z-score", value: 0.31 },
      { name: "momentum BTC/USDT entry", value: 97412.03 },
      { name: "momentum BTC/USDT stop", value: 96796.28 },
      { name: "momentum BTC/USDT target", value: 98643.53 },
      { name: "momentum BTC/USDT reward-to-risk", value: 2 },
    ],
  };
}

/** A signal that passes every guardrail against fixtureSnapshot(). */
export function goodSignal() {
  return {
    pair: "BTC/USDT",
    direction: "long",
    candidateId: BTC_CANDIDATE_ID,
    confidence: "medium",
    dataPoints: [
      { name: "BTC/USDT 15m RSI", value: 61.25 },
      { name: "BTC/USDT 15m volume vs 30d avg", value: 1.84 },
      { name: "BTC/USDT 4h MACD histogram", value: 80 },
    ],
    trigger: "Price holds above 97,412.03 with volume at 1.84x average",
    invalidation: "A 15m close below the stop at 96,796.28",
    rationale:
      "BTC is trending up on both timeframes: the 4h MACD histogram is 80 and volume is 1.84x its average while RSI at 61.25 is not overbought. The momentum candidate risks 15.8 USDT for a 2:1 target at 98,643.53.",
  };
}
