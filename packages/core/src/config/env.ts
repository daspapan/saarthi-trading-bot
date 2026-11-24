// Environment loading for every process.
//
// Two jobs live here:
// 1. The testnet-only guard (rule 6). Every process calls loadBaseEnv() at startup,
//    so no process can even start against a real-money exchange URL.
// 2. The analyst's loader (rule 1). It throws if any exchange key is visible,
//    so the AI process physically cannot hold keys.

export const TRADING_MODES = ["backtest", "paper", "testnet"] as const;
export type TradingMode = (typeof TRADING_MODES)[number];

/** Names of every secret. Only apps/executor is allowed to read their values. */
export const SECRET_ENV_KEYS = [
  "BINANCE_API_KEY",
  "BINANCE_API_SECRET",
  "BYBIT_API_KEY",
  "BYBIT_API_SECRET",
] as const;

/**
 * Trading venues we may ever talk to with keys. Exact origins only, so
 * "https://testnet.binance.vision.evil.com" or "https://api.binance.com" fail.
 */
export const KNOWN_TESTNET_ORIGINS = [
  "https://testnet.binance.vision",
  "wss://stream.testnet.binance.vision",
  "wss://ws-api.testnet.binance.vision",
  "https://api-demo.bybit.com",
  "wss://stream-demo.bybit.com",
] as const;

/**
 * The second price feed is a public, read-only, keyless mainnet stream from a
 * different source. It can never place an order, so it is checked against its
 * own short allowlist instead of the testnet list.
 */
export const KNOWN_PRICE_CHECK_ORIGINS = [
  "wss://stream.bybit.com",
  "wss://ws-feed.exchange.coinbase.com",
] as const;

/**
 * Two years of history for backtests come from Binance's public market-data
 * host. It serves prices only: it has no order or account endpoints at all.
 */
export const KNOWN_HISTORY_ORIGINS = ["https://data-api.binance.vision"] as const;

/** Checks HISTORY_BASE_URL (used only by npm run candles:download). */
export function loadHistoryUrl(env: Env = process.env): string {
  const url = env.HISTORY_BASE_URL || "https://data-api.binance.vision";
  const origin = originOf(url);
  const allowed: readonly string[] = KNOWN_HISTORY_ORIGINS;
  if (!origin || !allowed.includes(origin)) {
    throw new ConfigError(`HISTORY_BASE_URL="${url}" is not allowed. Use ${KNOWN_HISTORY_ORIGINS.join(", ")} (market data only).`);
  }
  return url;
}

export type BaseEnv = {
  tradingMode: TradingMode;
  dbPath: string;
  configDir: string;
  candlesDir: string;
  apiPort: number;
  apiHost: string;
  allowLan: boolean;
  pinHash: string | null;
  binanceBaseUrl: string;
  binanceWsUrl: string;
  bybitEnabled: boolean;
  bybitBaseUrl: string;
  priceCheckWsUrl: string;
  ollamaUrl: string;
  ollamaModel: string;
  analysisIntervalMin: number;
  logLevel: string;
};

type Env = Record<string, string | undefined>;

/** A startup problem we want to show as one clear sentence, not a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Throws unless `url` is exactly one of the known testnet or demo origins. */
export function assertTestnetUrl(name: string, url: string): void {
  const origin = originOf(url);
  const allowed: readonly string[] = KNOWN_TESTNET_ORIGINS;
  if (!origin || !allowed.includes(origin)) {
    throw new ConfigError(
      `${name}="${url}" is not a known testnet or demo URL. Saarthi is testnet-only and refuses to start. ` +
        `Allowed: ${KNOWN_TESTNET_ORIGINS.join(", ")}`,
    );
  }
}

function assertPriceCheckUrl(name: string, url: string): void {
  const origin = originOf(url);
  const allowed: readonly string[] = KNOWN_PRICE_CHECK_ORIGINS;
  if (!origin || !allowed.includes(origin)) {
    throw new ConfigError(
      `${name}="${url}" is not a known public market-data stream. Allowed: ${KNOWN_PRICE_CHECK_ORIGINS.join(", ")}`,
    );
  }
}

function parseMode(raw: string | undefined): TradingMode {
  if (!raw) {
    throw new ConfigError(`TRADING_MODE is missing. Set it to one of: ${TRADING_MODES.join(", ")}.`);
  }
  const modes: readonly string[] = TRADING_MODES;
  if (!modes.includes(raw)) {
    throw new ConfigError(`TRADING_MODE="${raw}" is not allowed. Use one of: ${TRADING_MODES.join(", ")}.`);
  }
  return raw as TradingMode;
}

function parseIntSafe(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name}="${raw}" must be a whole number.`);
  return n;
}

function parseBool(raw: string | undefined): boolean {
  return raw === "true" || raw === "1";
}

/**
 * Loads the settings every process shares. Never reads secret values.
 * Throws ConfigError with a plain-language message on any problem.
 */
export function loadBaseEnv(env: Env = process.env): BaseEnv {
  // A plain PIN in the environment would defeat hashing (rule CFG-08).
  if (env.PIN !== undefined) {
    throw new ConfigError("Found a plain PIN variable. Remove it and set PIN_HASH instead (npm run pin:hash -- <pin>).");
  }

  const base: BaseEnv = {
    tradingMode: parseMode(env.TRADING_MODE),
    dbPath: env.DB_PATH || "./data/saarthi.db",
    configDir: env.CONFIG_DIR || "./config",
    candlesDir: env.CANDLES_DIR || "./data/candles",
    apiPort: parseIntSafe("API_PORT", env.API_PORT, 4000),
    apiHost: env.API_HOST || "127.0.0.1",
    allowLan: parseBool(env.ALLOW_LAN),
    pinHash: env.PIN_HASH ? env.PIN_HASH : null,
    binanceBaseUrl: env.BINANCE_BASE_URL || "https://testnet.binance.vision",
    binanceWsUrl: env.BINANCE_WS_URL || "wss://stream.testnet.binance.vision/ws",
    bybitEnabled: parseBool(env.BYBIT_ENABLED),
    bybitBaseUrl: env.BYBIT_BASE_URL || "https://api-demo.bybit.com",
    priceCheckWsUrl: env.PRICE_CHECK_WS_URL || "wss://stream.bybit.com/v5/public/spot",
    ollamaUrl: env.OLLAMA_URL || "http://127.0.0.1:11434",
    ollamaModel: env.OLLAMA_MODEL || "qwen2.5:7b",
    analysisIntervalMin: parseIntSafe("ANALYSIS_INTERVAL_MIN", env.ANALYSIS_INTERVAL_MIN, 15),
    logLevel: env.LOG_LEVEL || "info",
  };

  // Rule 6: every exchange URL must be testnet/demo. Checked even when Bybit is
  // disabled, so a wrong value can't sit quietly in .env waiting to be enabled.
  assertTestnetUrl("BINANCE_BASE_URL", base.binanceBaseUrl);
  assertTestnetUrl("BINANCE_WS_URL", base.binanceWsUrl);
  assertTestnetUrl("BYBIT_BASE_URL", base.bybitBaseUrl);
  assertPriceCheckUrl("PRICE_CHECK_WS_URL", base.priceCheckWsUrl);

  return base;
}

/**
 * The analyst's loader. Rule 1: the AI process must not be able to see keys.
 * If any key variable exists at all (even empty), refuse to start.
 */
export function loadAnalystEnv(env: Env = process.env): BaseEnv {
  const leaked = SECRET_ENV_KEYS.filter((k) => env[k] !== undefined);
  if (leaked.length > 0) {
    throw new ConfigError(
      `The analyst must never see exchange keys, but found: ${leaked.join(", ")}. ` +
        "Keep keys only in .env.local, which only the executor loads.",
    );
  }
  return loadBaseEnv(env);
}
