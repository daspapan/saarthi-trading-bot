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
