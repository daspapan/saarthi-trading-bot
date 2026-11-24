import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  ConfigError,
  KNOWN_TESTNET_ORIGINS,
  SECRET_ENV_KEYS,
  applySettingChange,
  loadAnalystEnv,
  loadBaseEnv,
  loadSettingsFile,
  parseSettings,
} from "../src/index.ts";
import { validEnv } from "./helpers.ts";

const CONFIG_DIR = join(import.meta.dirname, "..", "..", "..", "config");

describe("CFG-01 testnet-only guard", () => {
  it("CFG-01 accepts the default testnet and demo URLs", () => {
    const env = loadBaseEnv(validEnv());
    expect(env.binanceBaseUrl).toBe("https://testnet.binance.vision");
    expect(env.bybitBaseUrl).toBe("https://api-demo.bybit.com");
  });

  it.each([
    ["BINANCE_BASE_URL", "https://api.binance.com"],
    ["BINANCE_BASE_URL", "https://testnet.binance.vision.evil.com"],
    ["BINANCE_BASE_URL", "http://testnet.binance.vision"],
    ["BINANCE_BASE_URL", "not a url"],
    ["BINANCE_WS_URL", "wss://stream.binance.com:9443/ws"],
    ["BYBIT_BASE_URL", "https://api.bybit.com"],
  ])("CFG-01 refuses to start with %s=%s and says why", (name, url) => {
    expect(() => loadBaseEnv(validEnv({ [name]: url }))).toThrow(ConfigError);
    expect(() => loadBaseEnv(validEnv({ [name]: url }))).toThrow(/not a known testnet or demo URL/);
  });

  it("CFG-01 checks Bybit's URL even when Bybit is disabled", () => {
    expect(() => loadBaseEnv(validEnv({ BYBIT_ENABLED: "false", BYBIT_BASE_URL: "https://api.bybit.com" }))).toThrow(
      ConfigError,
    );
  });

  it("CFG-01 only allows a known public stream for the read-only cross-check feed", () => {
    expect(() => loadBaseEnv(validEnv({ PRICE_CHECK_WS_URL: "wss://example.com/feed" }))).toThrow(
      /not a known public market-data stream/,
    );
    expect(KNOWN_TESTNET_ORIGINS).not.toContain("https://api.binance.com");
  });
});

describe("CFG-02 trading mode", () => {
  it("CFG-02 fails when TRADING_MODE is missing", () => {
    expect(() => loadBaseEnv({})).toThrow(/TRADING_MODE is missing/);
  });

  it.each(["live", "LIVE", "prod", ""])('CFG-02 fails when TRADING_MODE is "%s"', (mode) => {
    expect(() => loadBaseEnv({ TRADING_MODE: mode })).toThrow(ConfigError);
  });

  it.each(["backtest", "paper", "testnet"])("CFG-02 accepts %s", (mode) => {
    expect(loadBaseEnv({ TRADING_MODE: mode }).tradingMode).toBe(mode);
  });
});

describe("CFG-03 settings ranges", () => {
  const risk = loadSettingsFile(CONFIG_DIR, "risk.json");

  it("CFG-03 the shipped config files load and every default is inside its range", () => {
    expect(risk.riskPerTradeBps?.value).toBe(100);
    expect(loadSettingsFile(CONFIG_DIR, "strategy.json").pairs?.value).toEqual(["BTC/USDT", "ETH/USDT", "SOL/USDT"]);
  });

  it("CFG-03 rejects a value above max and keeps the old value", () => {
    const result = applySettingChange(risk, "riskPerTradeBps", 500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside the allowed range 10 to 200/);
    expect(result.settings.riskPerTradeBps?.value).toBe(100);
    expect(risk.riskPerTradeBps?.value).toBe(100);
  });

  it("CFG-03 rejects a value below min, a wrong type, an unknown key and a bad choice", () => {
    expect(applySettingChange(risk, "riskPerTradeBps", 1).ok).toBe(false);
    expect(applySettingChange(risk, "riskPerTradeBps", "100").ok).toBe(false);
    expect(applySettingChange(risk, "noSuchSetting", 1).ok).toBe(false);
    expect(applySettingChange(risk, "minConfidence", "low").ok).toBe(false);
  });

  it("CFG-03 accepts a value inside the range without mutating the original", () => {
    const result = applySettingChange(risk, "riskPerTradeBps", 50);
    expect(result.ok).toBe(true);
    expect(result.settings.riskPerTradeBps?.value).toBe(50);
    expect(risk.riskPerTradeBps?.value).toBe(100);
  });

  it("CFG-03 a config file whose default is out of range fails at startup", () => {
    expect(() => parseSettings("risk.json", { x: { value: 9, min: 1, max: 5, help: "h" } })).toThrow(
      /outside the allowed range/,
    );
    expect(() => parseSettings("risk.json", { x: { value: 1, min: 1, max: 5, help: "h", extra: 1 } })).toThrow(
      /invalid shape/,
    );
  });
});

describe("CFG-05 the analyst cannot load keys", () => {
  it.each(SECRET_ENV_KEYS)("CFG-05 analyst config loader throws when %s is present", (key) => {
    expect(() => loadAnalystEnv(validEnv({ [key]: "abc123secret" }))).toThrow(/must never see exchange keys/);
  });

  it("CFG-05 throws even when the key variable is present but empty", () => {
    expect(() => loadAnalystEnv(validEnv({ BINANCE_API_KEY: "" }))).toThrow(ConfigError);
  });

  it("CFG-05 loads normally with no keys present", () => {
    expect(loadAnalystEnv(validEnv()).tradingMode).toBe("paper");
  });
});
