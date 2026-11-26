# Saarthi

A local AI trading bot for a YouTube series, where **the AI is the analyst, never the trader**. A local model (Ollama) writes trade signals with reasons. Plain code checks every signal against hard risk rules, and only a separate executor process, the one that holds the exchange keys, places orders on an **exchange testnet with virtual money**.

> **Testnet with virtual funds. Not financial advice. Testnet results do not predict real results.**

Based on the LinkedIn articles "Trading Bot Part 01: What the YouTube video didn't tell you" and "Part 02: The AWS architecture behind an AI trading system that cannot go rogue". Every AWS service from Part 02 is replaced by a local equivalent.

## Status

Phase 8 of 9 done.

- Phase 1: workspace skeleton, config loading, SQLite migrations, testnet-only guard, `/health`, one-command start.
- Phase 2: two live price feeds (Binance Spot Testnet plus a public cross-check), 1m/15m/4h candles, `price_state` every 5 seconds, the stale and disagreement pause, exchange health checks, gap backfill, and a live health strip with price tiles.
- Phase 3: indicators (RSI, MACD, Bollinger, ATR, volume vs 30-day average), the three strategies with code-computed candidates and position sizing, the validator's risk rules, a two-year candle download, the backtester (fees, slippage, no look-ahead, buy-and-hold benchmark, walk-forward check) and the Backtest Lab page.

- Phase 4: the AI analyst (Ollama) with snapshots, a prompt that fences outside text, retries and fail-closed, the guardrails (schema, grounding of every cited number, injection screen) and the AI Analyst page.

- Phase 5: the deterministic 12-rule validator (checked against live state) and the order queue (dedupe, oldest first, stale items dropped, discard on kill switch), with each rule's result on the AI Analyst cards.

- Phase 6: the executor. One state machine (queued, re-check, place, wait for fill, place stop and target, open, closed) saved after every step, crash recovery and reconciliation on start, a simulated paper exchange and a Binance Spot Testnet client behind the same interface, and the Orders page.

- Phase 7: the risk monitor (daily loss limit with an 80% warning, drawdown stop, health alarms), the kill switch (hold-to-confirm button, `POST /kill`, and `npm run kill` for when the API is down), alerts as toasts plus optional ntfy / Telegram, and the Cockpit page.

- Phase 8: the Performance page (equity, drawdown, returns vs holding BTC, a daily P&L calendar), the Strategy and Risk page (change settings inside their ranges with the PIN), the Audit page (filters and "Verify chain"), dark mode, a Cmd+K command menu with keyboard shortcuts, plain-language tooltips, a phone layout with a STOP button, PIN-locked phone access over Wi-Fi, and installing the dashboard as a phone app.

Trading defaults to paper mode.

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

### The AI analyst: install Ollama and pull the model once

```bash
brew install ollama        # or download it from ollama.com
ollama serve               # leave running (the Ollama app does this for you)
ollama pull qwen2.5:7b     # about 4.7 GB
```

Then open http://127.0.0.1:3000/analyst and press **Analyse now**. The analyst also runs by itself every 15 minutes (`ANALYSIS_INTERVAL_MIN`). While the price feeds are paused it records "skipped: data not trusted" instead of calling the model.

### Trading on the Binance Spot Testnet (optional)

Paper mode (the default) needs nothing else. To trade on the real testnet with virtual funds:

1. Log in at https://testnet.binance.vision with GitHub and generate an HMAC API key.
2. Put the key in `.env.local` (gitignored; only the executor loads it):

   ```bash
   BINANCE_API_KEY=...
   BINANCE_API_SECRET=...
   ```

3. Set `TRADING_MODE=testnet` in `.env` and restart `npm run dev`.

The executor refuses to start in testnet mode without keys, and the client refuses any URL that isn't `testnet.binance.vision`. To run the exchange contract tests against the real testnet (they place a few tiny orders and cancel or sell them straight back):

```bash
SAARTHI_TESTNET_CONTRACT=1 node --env-file=.env.local node_modules/.bin/vitest run apps/executor/test/contract.test.ts
```

### The kill switch

On the Cockpit page: enter the PIN, then press and hold the red button for two seconds. Or from any terminal in the project folder, even with the API and web app stopped:

```bash
npm run kill -- <PIN>
```

Either way the executor cancels every order and sells every position within seconds, and trading stays stopped until you enter the PIN under "Restart trading". If no PIN is set, the kill switch works without one but restart is refused until you set `PIN_HASH`.

### Alerts on your phone (optional)

Alerts always show as toasts on the dashboard (and as browser notifications once you click "Enable browser notifications"). To get them on your phone too, set `NTFY_URL` (install the ntfy app and subscribe to a long random topic) and/or `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_CHAT_ID` in `.env`. If sending fails, it is logged and trading carries on.

### Using it from your phone

1. Set a PIN (below) and `ALLOW_LAN=true` in `.env`, then restart `npm run dev`.
2. The terminal prints `Dashboard on your network: http://192.168.x.x:3000`. Open that on your phone (same Wi-Fi).
3. Enter the PIN. The phone stays unlocked for 12 hours.
4. To install it: Safari > Share > Add to Home Screen, or Chrome > menu > Add to Home screen. It opens full screen with the STOP button always at the bottom.

Over plain http on Wi-Fi the browser won't run the offline page (that needs https), but everything else works. Nothing on the phone is ever cached: prices, orders and the kill switch always go to the live API.

### Keyboard

Cmd+K (Ctrl+K on Windows) opens the command menu. `g` then `c`, `a`, `o`, `p`, `b`, `s` or `l` jumps to a page; `t` switches the theme; `!` goes to the kill switch; `?` lists everything.

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
apps/executor   the only process with exchange keys: state machine loop, Binance testnet client
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

`POST /signals` (analyst token only): the analyst's run: `{ runId, trigger, snapshot, snapshotHash, source: "ollama" | "fail-closed" | "skipped", output, rawText, note, model, latencyMs, attempts }`. The API checks the hash, runs the guardrails on every signal, and stores everything (rejections included). Returns `201 { runId, snapshotHash, signals: [{ id, pair, direction, passed, reasons }] }`.

`GET /signals?limit=60`: newest first. Each card has `pair`, `direction`, `confidence`, `source`, `note`, `model`, `latencyMs`, `rationale`, `triggerText`, `invalidation`, `candidate` (from the snapshot), `evidence: [{ name, aiValue, snapshotValue, match }]` and `guardrails: { passed, reasons }`.

`GET /snapshots/:hash`: exactly what the AI saw for that run.

After the guardrails, every "long" or "exit" signal goes through the 12-rule validator against live state. If all 12 pass, it is queued. Each stored signal in the `POST /signals` reply then also has `validator: { passed, failedRules }` and `queue: { status: "queued" | "duplicate" | "not-queued", ... }`, and each card in `GET /signals` has `validator: { passed, rules: [{ rule, name, passed, message }] }` and `queue: { id, status, statusReason, createdAt }`.

`GET /queue?limit=50`: newest first, `{ items: [{ id, dedupeId, signalId, pair, direction, venue, status, statusReason, payload, createdAt, takenAt }] }`. `status` is `pending`, `taken`, `discarded` or `expired`.

`POST /analyse`: "Analyse now". Returns `202 { requestId, analystRunning, message }`.

The analyst's token (in `data/analyst.token`, created by the API) may read anything but write only to `/signals` and `/signals/heartbeat`; anything else gets 403.

`GET /orders?limit=30`: newest first, `{ states, orders: [{ id, pair, direction, side, type, state, quantity, filled, entryPrice, avgFillPrice, stopPrice, targetPrice, error, createdAt, updatedAt, events: [{ from, to, detail, at }] }] }`. `state` is one of `QUEUED`, `PRECHECK`, `PLACE_ENTRY`, `CONFIRM_FILL`, `PLACE_PROTECTION`, `OPEN`, `CLOSED`, `CANCELLED`, `FAILED`, `EMERGENCY_CLOSE`.

`GET /positions`: open positions, `{ positions: [{ id, pair, quantity, avgEntry, stopPrice, targetPrice, lastPrice, feesPaid, unrealisedPnl, unrealisedPct, progress, openedAt }] }`. `unrealisedPnl` is what selling at the last price would leave after the entry fee and an estimated 0.1% exit fee. `progress` is 0 at the stop and 1 at the target.

`GET /trades?limit=50`: closed trades, `{ trades: [{ orderId, pair, quantity, entryPrice, exitPrice, entryFee, exitFee, realisedPnl, closeReason, openedAt, closedAt }], totals: { count, wins, realisedPnl, fees } }`. All P&L is after fees. `realisedPnl` is `null` for a position that was closed outside Saarthi (testnet reset), because the exit price is unknown.

`GET /risk`: `{ equity, cash, dayStartEquity, highWaterMark, equityAt, equityAgeSec, assessment: { dailyPnl, dailyPnlPct, dailyLossLimit, dailyUsedPct, warn, limitHit, drawdownPct, drawdownLimitPct, drawdownHit } | null, breakdown: { realisedToday, unrealised, feesToday }, exposure: { total, pct, limitPct, byPair: [{ pair, value, pct, limitPct }] }, limits, flags: { killSwitch, manualRestart, dailyLimitHit, liquidating: { active, since, ordersLeft } }, pinRequired }`. Today's P&L is equity now minus equity at 00:00 UTC, so it includes realised and unrealised P&L and every fee paid.

`POST /kill` with `{ "pin": "1234" }`: `202 { alreadyActive, discarded, message }`. A wrong PIN is `403` and audited; after 5 wrong PINs in a minute, `429`. Pressing twice is safe.

`POST /restart` with `{ "pin": "1234" }`: `200` once everything is closed; `409` while positions are still being sold or when trading isn't stopped; `403` for a wrong PIN. It does not clear the daily loss limit, which resets at 00:00 UTC.

`GET /alerts?after=<id>&limit=50`: `{ latestId, alerts: [{ id, level: "info" | "warn" | "critical", kind, message, orderId, createdAt }] }`. With `after`, oldest first; without, newest first.

`GET /session`: `{ local, unlocked, pinRequired, lanEnabled }`. `POST /session` with `{ "pin": "1234" }` unlocks a phone: it sets an HttpOnly cookie valid for 12 hours. Anything else from a locked phone gets `401 { error, locked: true }`.

`GET /performance`: `{ curve: [{ t, equity, drawdownPct }], daily: [{ day, pnl, pnlPct }], windows: [{ days, actualDays, from, returnPct, btcPct }], summary: { startEquity, equity, totalReturnPct, maxDrawdownPct, trades, wins, fees, realisedPnl } }`. All after fees.

`POST /settings/preview` with `{ file: "risk.json" | "strategy.json", changes: { key: value } }`: `{ lines: [{ key, old, new, ok, reason, restart }] }`.

`POST /settings` with `{ file, changes, pin }`: all changes apply together or none do. `400` with the reason if any value is outside its range, `403` for a wrong PIN, `409` if no PIN is set. Settings marked `restart` (the pairs list and the feed thresholds) take effect after restarting `npm run dev`; the rest on the next check.

`GET /settings/history`: `{ history: [{ id, file, key, old, new, createdAt }], needsRestart }`.

`GET /audit?type=&actor=&q=&before=&limit=100`: newest first, `{ entries: [{ id, eventType, actor, payload, createdAt, hash, prevHash }], types, actors }`.

`GET /audit/verify`: recomputes every hash. `{ ok: true, checked, lastHash, ms }` or `{ ok: false, checked, badId, problem, ms }`.

`GET /settings`: both config files (`strategy`, `risk`) with each setting's value, allowed range and plain-language help.

`GET /backtests/data`: `{ "pairs", "files": [{ "pair", "timeframe", "candles", "first", "last" }], "range": { "from", "to" } | null, "hint" }`

`POST /backtests` with `{ "strategy": "all" | "statArb" | "momentum" | "meanReversion", "from": ms, "to": ms, "slippageBps": 0-50, "overrides": { "momentum.targetR": 3 }, "label": "optional name" }` returns `202 { "id", "status": "running" }`. Overrides must be inside each setting's allowed range. One run at a time (409 while one is running).

`GET /backtests`: `{ "runs": [{ "id", "label", "strategy", "status", "error", "from", "to", "createdAt", "summary": { "totalReturn", "cagr", "sharpe", "maxDrawdown", "trades", "benchmarkReturn" } }] }`

`GET /backtests/:id`: the run with `metrics`, `curve`, `drawdown`, `benchmark`, `walkForward`, `events`, `rejections`, `costs`, `trades` (latest 500) and `totalTrades`.

## Safety rules enforced from phase 1

- Every process refuses to start if an exchange URL isn't a known testnet or demo URL.
- `TRADING_MODE` must be `backtest`, `paper` or `testnet`. There is no live mode.
- The analyst refuses to start if any exchange key variable is visible to it.
- The API always listens on 127.0.0.1. With `ALLOW_LAN=true` (and a PIN hash), only the dashboard's port 3000 opens to your Wi-Fi, through a small gateway that tells the API who is really asking; a phone must enter the PIN first.
- Logs redact key fields and scrub key values from error messages.
- New signals pause whenever either price feed is stale (15 s), down, or disagrees with the other by more than 50 bps, and resume only after 60 s of agreement. If the feed process itself stops, prices are treated as untrusted.
- Three failed exchange health checks in a row discard that exchange's pending signals.
- Nothing reaches the order queue unless all 12 validator rules pass, checked against live state. The same signal can never be queued twice, and a queue item older than 15 minutes is dropped instead of executed.

Design choices are recorded in [DECISIONS.md](DECISIONS.md).
