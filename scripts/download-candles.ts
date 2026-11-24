// npm run candles:download
// Downloads two years of 15m and 1h candles for the configured pairs into data/candles.
// Read-only market data from data-api.binance.vision (no keys). Safe to stop and re-run:
// it resumes where it left off and reports any gaps.
import {
  type Candle,
  type Timeframe,
  ConfigError,
  createLogger,
  downloadCandles,
  loadHistoryUrl,
  loadSettingsFile,
  toCompactSymbol,
} from "@saarthi/core";

const log = createLogger("candles", { level: process.env.LOG_LEVEL });
const DAY = 86_400_000;

try {
  const base = loadHistoryUrl();
  const dir = process.env.CANDLES_DIR || "./data/candles";
  const pairs = loadSettingsFile(process.env.CONFIG_DIR || "./config", "strategy.json").pairs!.value as string[];
  const to = Math.floor(Date.now() / 3_600_000) * 3_600_000;
  const from = to - 730 * DAY;

  const fetchPage = async (pair: string, timeframe: Timeframe, startMs: number, limit: number): Promise<Candle[]> => {
    const qs = new URLSearchParams({ symbol: toCompactSymbol(pair), interval: timeframe, startTime: String(startMs), limit: String(limit) });
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}/api/v3/klines?${qs}`, { signal: AbortSignal.timeout(15_000) });
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= 4) throw new Error(`HTTP ${res.status} after ${attempt + 1} tries`);
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // back off and retry
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as unknown[][];
      return rows.map((r) => ({
        pair, timeframe, openTimeMs: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]),
      }));
    }
  };

  for (const pair of pairs) {
    for (const timeframe of ["15m", "1h"] as const) {
      const report = await downloadCandles({
        dir, pair, timeframe, from, to, fetchPage,
        onPage: (added, last) => process.stdout.write(`\r${pair} ${timeframe}: +${added} candles (up to ${new Date(last).toISOString().slice(0, 10)})   `),
      });
      process.stdout.write("\n");
      const resumed = report.resumedFrom ? `resumed from ${new Date(report.resumedFrom).toISOString()}, ` : "";
      log.info(`${pair} ${timeframe}: ${resumed}added ${report.added}, total ${report.total} in ${report.path}`);
      if (report.gaps.length) {
        const missing = report.gaps.reduce((a, g) => a + g.missing, 0);
        log.warn(`${pair} ${timeframe}: ${report.gaps.length} gap(s), ${missing} candles missing (exchange downtime). Backtests skip them.`);
      }
    }
  }
} catch (err) {
  log.fatal(err instanceof ConfigError ? err.message : `Download stopped: ${(err as Error).message}. Run it again to resume.`);
  process.exit(1);
}
