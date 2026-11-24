// Filling holes in stored candles from the exchange's public REST API
// (no keys needed). Used at startup, after every reconnect and every 5 minutes.

import type { Db } from "../db/db.ts";
import { type Candle, TIMEFRAMES, type Timeframe, bucketStart, findGaps, type Gap } from "./candles.ts";
import { loadCandles, rollupMinute, upsertCandle } from "./store.ts";

/** Fetches candles in [startMs, endMs). Implemented with fetch() in apps/feed. */
export type KlineFetcher = (pair: string, timeframe: Timeframe, startMs: number, endMs: number) => Promise<Candle[]>;

export type BackfillReport = { pair: string; timeframe: Timeframe; gaps: Gap[]; filled: number };

/**
 * Looks for missing candles in [fromMs, nowMs) and fetches them.
 * The minute still in progress is never backfilled (it isn't finished yet).
 */
export async function backfillGaps(
  db: Db,
  source: string,
  pair: string,
  timeframe: Timeframe,
  fromMs: number,
  nowMs: number,
  fetchKlines: KlineFetcher,
): Promise<BackfillReport> {
  const toMs = bucketStart(nowMs, timeframe); // exclude the open candle
  const have = loadCandles(db, source, pair, timeframe, fromMs, toMs).map((c) => c.openTimeMs);
  const gaps = findGaps(have, timeframe, fromMs, toMs);
  let filled = 0;
  for (const gap of gaps) {
    const candles = await fetchKlines(pair, timeframe, gap.startMs, Math.min(gap.endMs, toMs));
    for (const c of candles) {
      // Only accept candles inside the gap we asked for, on the right grid.
      if (c.openTimeMs < gap.startMs || c.openTimeMs >= gap.endMs || c.openTimeMs % TIMEFRAMES[timeframe] !== 0) continue;
      upsertCandle(db, source, { ...c, pair, timeframe });
      if (timeframe === "1m") rollupMinute(db, source, pair, c.openTimeMs);
      filled += 1;
    }
  }
  return { pair, timeframe, gaps, filled };
}
