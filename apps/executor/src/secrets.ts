// The ONLY file in the project that reads exchange key values.
// Keys come from .env.local, which only the executor's npm script loads.
// (A test in phase 6, EX-19, fails if any other file reads them.)

export type ExchangeKeys = {
  binance: { apiKey: string; secret: string } | null;
  bybit: { apiKey: string; secret: string } | null;
};

export function loadExchangeKeys(env: Record<string, string | undefined> = process.env): ExchangeKeys {
  const pair = (k: string | undefined, s: string | undefined) => (k && s ? { apiKey: k, secret: s } : null);
  return {
    binance: pair(env.BINANCE_API_KEY, env.BINANCE_API_SECRET),
    bybit: pair(env.BYBIT_API_KEY, env.BYBIT_API_SECRET),
  };
}

/** Every secret value, so the logger can scrub them from any line or error. */
export function secretValues(keys: ExchangeKeys): string[] {
  return [keys.binance, keys.bybit].flatMap((k) => (k ? [k.apiKey, k.secret] : []));
}
