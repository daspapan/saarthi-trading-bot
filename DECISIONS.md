# Decisions

Where the prompt left room, I picked the simpler option and wrote it down here.

## Phase 1

**Run TypeScript with Node's built-in type stripping (no tsx, no build step).** Node 22.18+ runs `.ts` files directly. That means no extra dependency and no `dist/` folder. The cost: relative imports end in `.ts`, and we avoid TypeScript-only runtime syntax like `enum` (we use `as const` arrays instead). `tsc` is used only for type checking (`npm run typecheck`). The web app is the exception; Next.js compiles itself.

**One workspace per process.** `apps/api`, `apps/feed`, `apps/analyst`, `apps/executor`, `apps/risk` and `apps/web` are separate packages, each started as its own OS process. Keeping the executor in its own folder makes rule 1 easy to check: `apps/executor/src/secrets.ts` is the only file that reads key values.

**Two env files.** `.env` holds shared, non-secret settings and is loaded by every process. `.env.local` holds exchange keys and is loaded only by the executor's npm script (`--env-file-if-exists=.env.local`). On top of that, the analyst's config loader throws if any key variable exists at all, even an empty one, so a key exported in your shell still can't reach the AI. Both files are gitignored. `.env.example` lists the key names as commented lines so they're documented without anyone copying them into `.env`.

**What "known testnet URL" means.** Exact origin match (scheme + host + port) against a short list: `https://testnet.binance.vision`, the Binance testnet WebSocket hosts, `https://api-demo.bybit.com` and Bybit's demo WebSocket host. Lookalikes such as `https://testnet.binance.vision.evil.com` fail. Bybit's URL is checked even when Bybit is disabled, so a wrong value can't hide in `.env`.

**The second price feed is mainnet public data, by design.** The spec asks for a read-only cross-check from a different source. It holds no keys and can't place orders, so it's checked against its own allowlist (Bybit public spot, Coinbase public feeds) instead of the testnet list. Default is Bybit's public spot stream because it quotes the same USDT pairs as Binance. Coinbase quotes USD, which usually sits within a few basis points of USDT but would add noise to the 50 bps disagreement check.

**Settings files are flat maps with the range beside the value.** For example `"riskPerTradeBps": { "value": 100, "min": 10, "max": 200, "help": "..." }`. Text choices use `allowed`, lists use `allowed` too, and on/off switches have only `value`. Startup fails if any default is outside its own range. Dotted keys (`momentum.stopAtr`) keep the file flat and the code simple.

**Some ranges are deliberately one-sided.** `minRewardToRisk` can't go below 1.5, `maxEntryDeviationBps` can't go above 30 (0.3%), and `maxSignalAgeMin` can't go above 15, because those limits are written into the spec's validator rules. The UI can make them stricter, never looser.

**PIN hashing uses scrypt from `node:crypto`.** Format `scrypt$<salt>$<hash>`, random salt, constant-time compare. The hash lives in `.env` as `PIN_HASH` (create it with `npm run pin:hash -- <pin>`). A plain `PIN` variable makes startup fail.

**LAN access needs a PIN.** `ALLOW_LAN=true` binds the API to `0.0.0.0` and refuses to start without `PIN_HASH`. Any non-loopback `API_HOST` without `ALLOW_LAN` is refused, so there's one obvious switch.

**The browser talks only to Next.js.** Next.js forwards `/backend/*` to the API on 127.0.0.1:4000. No CORS setup, and the phone only needs the dashboard port. (If Server-Sent Events buffer badly through the rewrite in phase 2, I'll revisit this.)

**Added a `process_heartbeats` table.** Not in the spec's table list, but the health strip needs to know whether each process is alive. Each process writes a beat every 5 seconds; `/health` calls a process down after 15 seconds of silence.

**The audit log's append-only triggers ship now.** The hash chain, Verify button and AUD tests come in phase 8, but the table refuses UPDATE and DELETE from day one.

**`npm run seed` only runs in paper mode** and resets the trading tables to a clean 10,000 USDT account. It never touches `audit_log`.

**SQLite warning silenced in npm scripts.** Node prints an "experimental" warning for `node:sqlite`. The npm scripts pass `--disable-warning=ExperimentalWarning` so the terminal stays readable on video.

**Library versions.** The first install pulled Next.js 15 and Vitest 3, which `npm audit` flagged (postcss, tinypool). I moved to Next.js 16 and Vitest 5, which audit clean.

**Test IDs covered in phase 1:** CFG-01, CFG-02, CFG-03, CFG-05, CFG-06, CFG-07, CFG-08, CFG-10, DB-01, DB-02, plus API-02 and API-03 for `/health`. CFG-04 (PIN-protected setting changes, audited) and CFG-09 (analyst token scope) need the audit chain and `POST /signals`, so they land in phases 8 and 4.

## Phase 2

**Light theme is the default** (your request). The colours sit in `globals.css` as theme variables, so a dark theme can be added later as a toggle without touching components.

**Animated arrows use plain CSS keyframes, not the Motion library.** Two stacked chevrons half a beat apart give a steady rising (UP) or sinking (DOWN) motion. Stale/failing states get a pulsing amber dot, and idle states a still dash. Under `prefers-reduced-motion` the arrows stand still and price flashes are off. The arrows are decorative (`aria-hidden`): the word beside them (UP, DOWN, STALE) always carries the meaning.

**Feed A uses Binance's raw `/ws` endpoint with a SUBSCRIBE message** for `<pair>@trade` (candles) and `<pair>@ticker` (bid, ask, last, 24h change, volume). No extra dependency: Node 22 has a built-in WebSocket client.

**Staleness is per feed and per pair, measured with our own receive time.** If any pair on either feed has had nothing for 15 seconds, signals pause. Using our clock (not the exchange's timestamps) means a skewed exchange clock can't hide a dead feed.

**"More than 50 bps" means 50.0 is still allowed.** The test checks that 49 passes, a gap right at 50 passes and 51 pauses. The gap is measured against the midpoint of the two prices.

**Signals start paused.** After any restart, prices are trusted only once both feeds have been live and in agreement for 60 seconds. Starting paused isn't an alarm; only a change from allowed to paused is.

**Alarms fire once per event.** The monitor reports `change: "paused"` or `"resumed"` only on the check where the state flips, and only then writes an audit row and a warning log line. Toasts, browser notifications and ntfy come in phase 7 and will hook into the same event.

**The trust check fails closed.** `readFeedTrust()` is what the analyst and validator will call. It says "not trusted" if the feed process has never reported, if its last report is older than 15 seconds (process crashed), or if it reported "paused". A crashed feed process can never leave an old "all good" verdict behind.

**Quiet minutes become flat candles; disconnects become gaps.** On a quiet testnet a minute may have no trades. That minute is stored like Binance's own klines: open = high = low = close = previous close, volume 0. Without this, the 15m and 4h candles could never be built. When the socket drops, the minute in progress is thrown away instead. The gap is then filled from REST with real data (after every reconnect, every 5 minutes, and at startup), not with made-up flat candles. A silence longer than 60 minutes is also left as a gap.

**15m and 4h candles are rebuilt only from a complete run of minutes.** A partial set of minutes never overwrites a candle that was correctly backfilled from REST.

**Duplicate protection on reconnect has two layers.** Binance trade IDs only go up, so a replayed trade (same or lower ID) is ignored. On top of that, every candle write is an upsert on (source, pair, timeframe, open time).

**Backfill windows:** 1m for the last 24 hours; 15m and 4h for the last 35 days, enough for MACD on 4h and a 30-day volume average in phase 3. History comes from the testnet's public `/api/v3/klines` with no keys.

**Exchange health uses `GET /api/v3/ping` every 30 seconds** with a 5-second timeout. Three failures in a row mark Binance unavailable, discard that venue's pending queue items (a `venue` column was added to `order_queue` for this), set the `exchange_unavailable` flag and write one audit row. One success brings it back.

**Two more tables:** `feed_monitor` (one row: paused or not, the reason, the resume countdown, per-pair gaps) and `exchange_health`. Added in `002_feeds.sql`.

**The audit log's write side ships now** (`appendAudit`, hash-chained, with a write lock so two processes can't fork the chain), because phase 2 already produces alarms. Verify chain and the Audit page are still phase 8.

**The dashboard polls every 2 seconds for now.** The SSE stream (API-01) comes with live signals and orders, where push really matters.

**Added `@vitest/coverage-v8`** (dev only) after you asked for every scenario to be covered. `npm run coverage` fails if `packages/core` drops below 90% of lines. It's at 96% now.

**Watch out: Binance Spot Testnet is its own order book.** Its prices usually follow the real market but can drift. If feed A and feed B disagree by more than 50 bps for long stretches, signals will stay paused. That is the system working as designed, not a bug. If it happens all the time, raise `feedDisagreementBps` in `config/risk.json` (allowed up to 200) and note it in the video.

**I couldn't reach the live streams from my workspace** (the sandbox blocks exchange hosts). Every scenario is tested against fake sockets, a fake REST server and a fake clock. I checked the screens by running the real feed service with a scripted stream of realistic Binance and Bybit messages. The first run against the real testnet is the one step to confirm on your Mac.

**Phase 2 test IDs:** FEED-01 to FEED-08 (all), plus API-02 and API-03 for `/health`, `/prices` and `/candles`, and UI-01 display logic for the health strip. The Playwright browser scene for UI-01 lands in phase 9.

## Phase 3

**`pino-pretty` is on by default** (`LOG_PRETTY=true`). It runs synchronously, so a fatal startup message is printed before the process exits. Redaction and key scrubbing happen inside pino before formatting, and a test checks pretty output for leaked keys too. Set `LOG_PRETTY=false` for raw JSON lines.

**Indicators are series, not single values.** Each function returns one value per candle (null while warming up), so the live snapshot takes the last value and the backtester walks forward through the same arrays. Live and backtest literally share the maths. Too little data gives null ("not available"), never NaN or 0.

**Indicators are checked against independent formulas written in the tests**, not against numbers copied from a website. On Wilder's own RSI dataset our values are 70.46, 66.25, 66.48…. StockCharts' table shows 70.53, 66.32…, because their spreadsheet uses unrounded prices; our textbook Wilder formula gives exactly the library's values on the rounded prices.

**Two library quirks found and handled:**
- `technicalindicators` reports a MACD signal of exactly 0 as `undefined` (seen on a flat series). We rebuild it as MACD − histogram.
- ATR follows the convention that true range needs a previous close, so the first ATR appears at candle 14 (index 14), not 13. Our reference test uses the same convention.

**Volume vs 30-day average** is each candle's volume divided by the average of the previous 30 days of candles (2,880 on 15m, 180 on 4h). Momentum can't fire in the first 30 days of history, by design.

**Strategy rules (all thresholds in `config/strategy.json`, with ranges):**
- *Momentum:* 4h MACD histogram > 0 and 4h close above its 20-period middle band; 15m MACD histogram > 0 and price above its middle band; 15m volume ≥ 1.3× average; RSI < 70. Stop 1.5 ATR, target 2× the stop distance.
- *Mean reversion:* only when the 15m Bollinger width is ≤ 4% of price (low volatility); price at or below the lower band and RSI ≤ 30. Stop 1 ATR, target the middle band. Its R:R is whatever the band gives; the validator decides if that's enough.
- *Stat-arb:* rolling z-score of the BTC/ETH price ratio over 96 candles (1 day). At |z| ≥ 2 it buys the cheap side (BTC if z ≤ −2, ETH if z ≥ +2). The target is the price that would put the ratio back at its average with the other leg unchanged. Stop 2 ATR. When |z| ≤ 0.5 it proposes an exit for holdings that stat-arb opened.

**Spot only, enforced in the types.** A candidate's direction can only be `long` or `exit`. Exits come only from stat-arb (momentum and mean reversion exit through their stop/target OCO) and only for assets we actually hold. No new entry is proposed in a pair we already hold.

**Candidate prices are rounded** (2 decimals above 100, 4 below 100, 6 below 1) before reward-to-risk is computed, so the AI in phase 4 copies short, exact numbers. Quantities are rounded down to 6 decimals. A property test also caught a floating-point edge case in that rounding (0.063439 became 0.063438), which is fixed.

**Position size** is the smallest of: 1% risk if the stop is hit, the 25% per-asset limit (minus what we already hold), the 60% total exposure limit, and free cash (spot never borrows). Orders under 10 USDT are skipped with a reason. A new `minOrderUsdt` risk setting holds that minimum.

**The validator's risk rules ship now, ahead of phase 5** (rules 5, 6, 7, 8, 9 and 11: daily loss, trades per day, risk per trade, position and exposure limits including "never borrow", no conflicting position, stop distance and R:R). The backtester calls exactly this function, so BT-01 is real today. Phase 5 adds the live-only rules (schema and grounding, signal and snapshot age, feed health, kill switch, confidence, entry vs current price), and the full VAL test set.

**SNAP-01 to SNAP-03 move to phase 4.** The snapshot is what the analyst sends to the model, so it's built with the analyst. The canonical JSON and SHA-256 helpers it needs already exist.

**Backtester timing has no look-ahead.** Decisions happen at a 15m candle's close, using only closed candles (a 4h candle counts only after its 4 hours end). Orders execute on the next candle. A test proves it: wildly changing all candles after a date leaves every earlier trade identical.

**The simulated exchange is pessimistic on purpose:**
- A 0.1% fee and slippage (default 5 bps) on every fill, including limits.
- A limit buy fills only if the price trades *below* it; touching isn't enough.
- An unfilled entry is cancelled after one candle, like the live 60-second timeout.
- A gap through a stop fills at the open.
- If a candle touches both stop and target, the stop wins.
- On the candle an entry fills, only the stop counts (we can't know whether the high came before our fill).

**Risk controls act in the backtest like they do live.** The daily loss limit blocks entries until UTC midnight. The max drawdown closes everything and stops trading for the rest of the run (live, that's the PIN restart). Both appear under "Risk controls that fired".

**Walk-forward:** the same settings on the first 70% and the last 30%. Nothing is tuned on the first part, so this is an honesty check, not an optimiser. It warns when either part has fewer than 5 trades, when the yearly returns have opposite signs, or when out-of-sample Sharpe is under half of in-sample. If both parts lose money, the page says so in red instead of "they agree".

**Metric conventions:** a year is 365 days (crypto never closes); Sharpe and Sortino use daily returns, risk-free rate 0, sample standard deviation; Sortino's downside deviation is taken over all days; profit factor is empty when there are no losing trades. A hand-calculated fixture pins every number.

**History comes from `data-api.binance.vision`, Binance's market-data-only host** (it has no order or account endpoints at all). `HISTORY_BASE_URL` is checked against that one host. The download stores 15m and 1h CSVs. 4h candles are rolled up from 1h, keeping only complete 4-hour buckets. The download resumes after an interruption (each page is appended as it arrives). It survives a crash mid-line (a test found and fixed a bug where the next row was glued onto a broken line). It retries HTTP 429/5xx with backoff, and reports gaps.

**Backtests run in a worker thread,** so a two-year run (about 4–5 s for three pairs plus the walk-forward) never blocks the API. In my run `/health` answered in 2 ms during a backtest. That matters because the kill switch will live on the API. One run at a time (409 otherwise). A run left "running" by a crash is marked failed when the API restarts.

**Parameter overrides in the Backtest Lab must stay inside each setting's approved range,** the same rule the Strategy and Risk page will use. The API refuses anything else with the reason.

**Charts use Recharts** (listed in the stack). Their animation is turned off when the viewer prefers reduced motion. Equity and buy-and-hold share one chart; comparisons plot each run as % change from its own start, so runs over different periods still line up.

**Phase 3 test IDs:** IND-01 to IND-06, STR-01 to STR-07, BT-01 to BT-10 (all), plus API-02/API-03 for the backtest endpoints, UI-11 display logic, and backtest checks of RISK-03 and RISK-06 behaviour. The full RISK set comes with the risk process in phase 7.

**Screenshots of the Lab were made with a seeded random-walk market**, because exchange hosts are blocked from my workspace. On a random walk no strategy has an edge, so all three lose about 15% after costs and hit the drawdown stop while BTC buy-and-hold is up. That's the correct, honest outcome. Run `npm run candles:download` for real data.
