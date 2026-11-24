# Saarthi

A local AI trading bot for a YouTube series, where **the AI is the analyst, never the trader**. A local model (Ollama) writes trade signals with reasons. Plain code checks every signal against hard risk rules, and only a separate executor process, the one that holds the exchange keys, places orders on an **exchange testnet with virtual money**.

> **Testnet with virtual funds. Not financial advice. Testnet results do not predict real results.**

Based on the LinkedIn articles "Trading Bot Part 01: What the YouTube video didn't tell you" and "Part 02: The AWS architecture behind an AI trading system that cannot go rogue". Every AWS service from Part 02 is replaced by a local equivalent.

## Status

Phase 3 of 9 done.

- Phase 1: workspace skeleton, config loading, SQLite migrations, testnet-only guard, `/health`, one-command start.
- Phase 2: two live price feeds (Binance Spot Testnet plus a public cross-check), 1m/15m/4h candles, `price_state` every 5 seconds, the stale and disagreement pause, exchange health checks, gap backfill, and a live health strip with price tiles.
- Phase 3: indicators (RSI, MACD, Bollinger, ATR, volume vs 30-day average), the three strategies with code-computed candidates and position sizing, the validator's risk rules, a two-year candle download, the backtester (fees, slippage, no look-ahead, buy-and-hold benchmark, walk-forward check) and the Backtest Lab page.

No AI or live orders yet.

## Setup on a Mac

You need **Node 22.18 or newer** (`node -v`). Ollama and Binance testnet keys aren't needed until phases 4 and 6.

```bash
cd saarthi
npm install
cp .env.example .env          # shared settings, no secrets
npm run seed                  # paper account with 10,000 USDT
npm run dev                   # starts api, feed, analyst, executor, risk and web
```

Open http://127.0.0.1:3000. Within a few seconds you should see:

- three price tiles (BTC, ETH, SOL) with bid, ask, the 24h change and an arrow, feed B's price and the gap between the feeds in bps
- an amber banner, "New signals paused · resuming in …s", counting down for 60 seconds, then turning green: "Signals allowed"
- the health strip: Feed A, Feed B and Exchange API, then the five processes, each with an animated arrow and the word UP

### Backtests: download two years of history once

```bash
npm run candles:download
```

This fetches 15m and 1h candles for BTC, ETH and SOL from Binance's public market-data host (no keys, read-only) into `data/candles/`. It takes a few minutes. If it's interrupted, run it again: it resumes. Then open http://127.0.0.1:3000/backtest, pick a strategy and dates, and press **Run backtest**.

### Optional: a PIN (needed for phone access later)

```bash
npm run pin:hash -- 482916    # prints PIN_HASH=scrypt$...
```

Paste that line into `.env`. The plain PIN is never stored.

## Running the tests

```bash
npm test             # all tests (vitest)
npm run coverage     # tests plus coverage; fails if packages/core drops below 90% of lines
npm run typecheck    # TypeScript check, no output means OK
```

## Project layout

```
apps/api        Express HTTP API (and SSE later)
apps/feed       market data process
apps/analyst    AI analyst process (never has keys)
apps/executor   the only process with exchange keys
apps/risk       risk monitor and kill switch
apps/web        Next.js dashboard
packages/core   shared config, database, logger, and later indicators, validator, state machine
config/         strategy.json and risk.json: defaults plus allowed ranges
data/           SQLite file and downloaded candles (gitignored)
```

## API

All read-only for now. Errors are `{ "error": "plain-language reason" }`.

`GET /health`:

```json
{
  "ok": true,
  "mode": "paper",
  "testnetOnly": true,
  "time": "2026-11-24T07:05:21.000Z",
  "db": "ok",
  "processes": [{ "name": "feed", "status": "up", "lastBeatAgoSec": 4, "detail": "A ok, B ok, signals allowed, exchange ok" }],
  "feeds": {
    "trusted": false,
    "paused": true,
    "reason": "Feeds agree; waiting before resuming signals",
    "resumeInSec": 42,
    "resumeAfterSec": 60,
    "feeds": [{ "id": "A", "status": "ok", "lastDataAgoSec": 1, "detail": "Feed A is live" }],
    "pairs": [{ "pair": "BTC/USDT", "priceA": 97412.03, "priceB": 97420.5, "disagreementBps": 0.87, "agrees": true }]
  },
  "exchange": { "venue": "binance", "status": "ok", "detail": "Binance testnet REST is answering." },
  "disclaimer": "Testnet with virtual funds. ..."
}
```

- Process `status`: `up`, `down` (no heartbeat for 15 s) or `never-started`.
- Feed `status`: `ok`, `stale`, `down` or `unknown` (the feed process isn't reporting).
- Exchange `status`: `ok`, `failing`, `unavailable` or `unknown`.

`GET /prices`: `{ "prices": [{ "pair", "bid", "ask", "last", "change24hPct", "volume24h", "checkPrice", "disagreementBps", "updatedAt", "ageSec" }] }`

`GET /candles?pair=BTC/USDT&tf=15m&limit=200`: `{ "pair", "timeframe", "candles": [{ "time", "open", "high", "low", "close", "volume" }] }`, oldest first. `tf` is `1m`, `15m`, `1h` or `4h`; `limit` is 1 to 1000.

`GET /settings`: both config files (`strategy`, `risk`) with each setting's value, allowed range and plain-language help.

`GET /backtests/data`: `{ "pairs", "files": [{ "pair", "timeframe", "candles", "first", "last" }], "range": { "from", "to" } | null, "hint" }`

`POST /backtests` with `{ "strategy": "all" | "statArb" | "momentum" | "meanReversion", "from": ms, "to": ms, "slippageBps": 0-50, "overrides": { "momentum.targetR": 3 }, "label": "optional name" }` returns `202 { "id", "status": "running" }`. Overrides must be inside each setting's allowed range. One run at a time (409 while one is running).

`GET /backtests`: `{ "runs": [{ "id", "label", "strategy", "status", "error", "from", "to", "createdAt", "summary": { "totalReturn", "cagr", "sharpe", "maxDrawdown", "trades", "benchmarkReturn" } }] }`

`GET /backtests/:id`: the run with `metrics`, `curve`, `drawdown`, `benchmark`, `walkForward`, `events`, `rejections`, `costs`, `trades` (latest 500) and `totalTrades`.

## Safety rules enforced from phase 1

- Every process refuses to start if an exchange URL isn't a known testnet or demo URL.
- `TRADING_MODE` must be `backtest`, `paper` or `testnet`. There is no live mode.
- The analyst refuses to start if any exchange key variable is visible to it.
- The API listens on 127.0.0.1 unless `ALLOW_LAN=true` and a PIN hash are set.
- Logs redact key fields and scrub key values from error messages.
- New signals pause whenever either price feed is stale (15 s), down, or disagrees with the other by more than 50 bps, and resume only after 60 s of agreement. If the feed process itself stops, prices are treated as untrusted.
- Three failed exchange health checks in a row discard that exchange's pending signals.

Design choices are recorded in [DECISIONS.md](DECISIONS.md).
