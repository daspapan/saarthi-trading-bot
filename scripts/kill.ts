// The kill switch from a terminal: works even when the API and web app are down.
//   npm run kill -- <PIN>
// It only writes to the database; the executor closes everything within seconds.

import { loadBaseEnv, migrate, openDb, readProcessStatus, triggerLiquidation, verifyPin } from "@saarthi/core";

const env = loadBaseEnv();
const pin = process.argv[2];
if (env.pinHash && !(pin && verifyPin(pin, env.pinHash))) {
  console.error("Wrong or missing PIN. Usage: npm run kill -- <PIN>");
  process.exit(1);
}
const db = openDb(env.dbPath);
migrate(db);
const r = triggerLiquidation(db, { source: "kill-switch", reason: "Pressed from the terminal (npm run kill).", actor: "operator-cli" });
console.log(r.alreadyActive ? "The kill switch was already closing everything." : `Kill switch on. ${r.discarded} pending signal(s) discarded.`);
const executor = readProcessStatus(db).find((p) => p.name === "executor");
console.log(
  executor?.status === "up"
    ? "The executor is cancelling every order and selling every position. Watch the Orders page."
    : "The executor isn't running. Start it (npm run dev) and it will close everything as soon as it starts. Your stops stay on the exchange meanwhile.",
);
console.log("Trading stays stopped until you restart it with the PIN on the Cockpit page.");
db.close();
