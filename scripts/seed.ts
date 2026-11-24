// npm run seed: reset paper mode to a clean 10,000 USDT account.
import { ConfigError, latestEquity, loadBaseEnv, migrate, openDb, seedPaper } from "@saarthi/core";

const env = loadBaseEnv();
if (env.tradingMode !== "paper") {
  throw new ConfigError(`The demo seed only runs in paper mode (TRADING_MODE is "${env.tradingMode}").`);
}
const db = openDb(env.dbPath);
migrate(db);
seedPaper(db);
console.log(`Seeded paper account: ${latestEquity(db)} USDT.`);
db.close();
