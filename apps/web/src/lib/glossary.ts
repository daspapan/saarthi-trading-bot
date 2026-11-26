// Plain-language explanations for every trading term the dashboard uses.
// Shown as tooltips (hover, focus or tap) wherever the term appears.

export const GLOSSARY: Record<string, string> = {
  RSI: "Relative Strength Index, 0 to 100. Above 70 the price has risen fast (overbought); below 30 it has fallen fast (oversold).",
  MACD: "Moving Average Convergence Divergence: the gap between a fast and a slow average of the price. Positive and rising means upward momentum.",
  ATR: "Average True Range: how much the price typically moves in one candle. Stops are placed a few ATRs away so normal wiggles don't hit them.",
  Bollinger: "Bollinger Bands: a band two standard deviations around the 20-candle average. A narrow band means the market is quiet.",
  "z-score": "How many standard deviations a value is from its average. Stat-arb trades when the BTC/ETH price ratio is unusually far from normal.",
  OCO: "One-Cancels-the-Other: a stop-loss and a take-profit placed together on the exchange. When one fills, the exchange cancels the other.",
  "stop-loss": "A sell order that triggers if the price falls to a set level, to cap the loss on a trade.",
  "take-profit": "A sell order at a higher price that locks in the gain when the price gets there.",
  drawdown: "How far equity is below its highest point so far, in percent. At 15% Saarthi sells everything and waits for a PIN restart.",
  "high-water mark": "The highest equity reached so far. Drawdown is measured from here.",
  equity: "Everything the account is worth right now: cash plus coins valued at the latest price.",
  exposure: "The value of all open positions as a share of equity.",
  "P&L": "Profit and loss. Saarthi always shows it after fees.",
  slippage: "The difference between the price you expected and the price you got. Saarthi assumes a little on every fill, so results aren't flattering.",
  "kill switch": "Cancels every order and sells every position at market, then stops trading until you restart it with the PIN.",
  "daily loss limit": "If today's loss reaches 2% of the equity at 00:00 UTC, no new orders until the next UTC day. Open positions keep their stops.",
  "R multiple": "Profit or loss measured in units of the risk taken. A target at 2R is twice as far from the entry as the stop.",
  "walk-forward": "Testing a strategy on data it wasn't tuned on (the later 30%) to see whether the results hold up.",
  "Sharpe ratio": "Return per unit of volatility. Higher is better; below 1 is weak.",
  testnet: "Binance's practice exchange with virtual money. Nothing here is real money.",
};

/** Finds the glossary entry for a term, ignoring case. */
export function explain(term: string): string | null {
  const key = Object.keys(GLOSSARY).find((k) => k.toLowerCase() === term.toLowerCase());
  return key ? GLOSSARY[key]! : null;
}
