// Historical candles on disk: data/candles/BTCUSDT-15m.csv and friends.
// One CSV per pair and timeframe: open_time,open,high,low,close,volume
//
// The download appends one page (1000 candles) at a time, so if it is
// interrupted (Wi-Fi drops, Ctrl+C) the next run resumes after the last
// complete line instead of starting over, and never writes a candle twice.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Candle, type Gap, TIMEFRAMES, type Timeframe, findGaps, rollup } from "../feed/candles.ts";

export const CSV_HEADER = "open_time,open,high,low,close,volume";

export const candleCsvPath = (dir: string, pair: string, timeframe: Timeframe) =>
  join(dir, `${pair.replace("/", "")}-${timeframe}.csv`);

/** Reads a candle CSV. Skips the header and any broken line (e.g. a half-written last line). */
export function readCandlesCsv(path: string, pair: string, timeframe: Timeframe): Candle[] {
  if (!existsSync(path)) return [];
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const parts = line.trim().split(",");
    if (parts.length !== 6) continue;
    const [t, o, h, l, c, v] = parts.map(Number) as [number, number, number, number, number, number];
    if (![t, o, h, l, c, v].every(Number.isFinite) || seen.has(t)) continue;
    seen.add(t);
    out.push({ pair, timeframe, openTimeMs: t, open: o, high: h, low: l, close: c, volume: v });
  }
  return out.sort((a, b) => a.openTimeMs - b.openTimeMs);
}

/** Reads only the last byte, so appending to a big file stays cheap. */
function endsWithNewline(path: string): boolean {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function appendCandlesCsv(path: string, candles: readonly Candle[]): void {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${CSV_HEADER}\n`);
  }
  if (!candles.length) return;
  const text = candles.map((c) => `${c.openTimeMs},${c.open},${c.high},${c.low},${c.close},${c.volume}`).join("\n");
  // If a previous run died mid-line, start on a fresh line so the broken
  // fragment stays on its own (and is skipped) instead of corrupting this row.
  const prefix = endsWithNewline(path) ? "" : "\n";
  appendFileSync(path, `${prefix}${text}\n`);
}

/** One page of candles starting at startMs (at most `limit`). */
export type PageFetcher = (pair: string, timeframe: Timeframe, startMs: number, limit: number) => Promise<Candle[]>;

export type DownloadReport = {
  pair: string;
  timeframe: Timeframe;
  path: string;
  resumedFrom: number | null;
  added: number;
  total: number;
  gaps: Gap[];
};

export async function downloadCandles(opts: {
  dir: string;
  pair: string;
  timeframe: Timeframe;
  from: number;
  to: number;
  fetchPage: PageFetcher;
  pageSize?: number;
  onPage?: (added: number, lastTime: number) => void;
}): Promise<DownloadReport> {
  const { dir, pair, timeframe, from, to, fetchPage } = opts;
  const pageSize = opts.pageSize ?? 1000;
  const step = TIMEFRAMES[timeframe];
  mkdirSync(dir, { recursive: true });
  const path = candleCsvPath(dir, pair, timeframe);

  const existing = readCandlesCsv(path, pair, timeframe);
  const lastTime = existing.at(-1)?.openTimeMs ?? null;
  let cursor = lastTime !== null ? lastTime + step : from;
  let added = 0;

  while (cursor < to) {
    const page = (await fetchPage(pair, timeframe, cursor, pageSize))
      .filter((c) => c.openTimeMs >= cursor && c.openTimeMs < to && c.openTimeMs % step === 0)
      .sort((a, b) => a.openTimeMs - b.openTimeMs);
    if (!page.length) break;
    appendCandlesCsv(path, page);
    added += page.length;
    cursor = page.at(-1)!.openTimeMs + step;
    opts.onPage?.(added, cursor);
  }

  const all = readCandlesCsv(path, pair, timeframe);
  // Ignore the still-open candle at the end of the window when looking for gaps.
  const gapEnd = Math.min(to, Math.floor(Date.now() / step) * step);
  return {
    pair,
    timeframe,
    path,
    resumedFrom: lastTime !== null ? lastTime + step : null,
    added,
    total: all.length,
    gaps: findGaps(all.map((c) => c.openTimeMs), timeframe, Math.max(from, all[0]?.openTimeMs ?? from), gapEnd),
  };
}

export type BacktestCandles = {
  candles15: Record<string, Candle[]>;
  candles4h: Record<string, Candle[]>;
  /** Overlapping range covered by every pair's 15m data. */
  range: { from: number; to: number } | null;
};

/** Loads 15m candles, and builds 4h from 1h (or from 15m if 1h is missing). */
export function loadBacktestCandles(dir: string, pairs: readonly string[]): BacktestCandles {
  const candles15: Record<string, Candle[]> = {};
  const candles4h: Record<string, Candle[]> = {};
  let from = -Infinity;
  let to = Infinity;
  for (const pair of pairs) {
    const c15 = readCandlesCsv(candleCsvPath(dir, pair, "15m"), pair, "15m");
    const c1h = readCandlesCsv(candleCsvPath(dir, pair, "1h"), pair, "1h");
    candles15[pair] = c15;
    // A partial 4h bucket at either end would be a fake candle, so keep only full ones.
    const source = c1h.length ? c1h : c15;
    const perBucket = TIMEFRAMES["4h"] / TIMEFRAMES[source[0]?.timeframe ?? "15m"];
    const counts = new Map<number, number>();
    for (const c of source) {
      const b = Math.floor(c.openTimeMs / TIMEFRAMES["4h"]) * TIMEFRAMES["4h"];
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    candles4h[pair] = rollup(source, "4h").filter((c) => counts.get(c.openTimeMs) === perBucket);
    if (c15.length) {
      from = Math.max(from, c15[0]!.openTimeMs);
      to = Math.min(to, c15.at(-1)!.openTimeMs + TIMEFRAMES["15m"]);
    } else {
      from = Infinity;
    }
  }
  return { candles15, candles4h, range: Number.isFinite(from) && Number.isFinite(to) && from < to ? { from, to } : null };
}
