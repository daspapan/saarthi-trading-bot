// npm run migrate: create or update the SQLite database.
import { loadBaseEnv, migrate, openDb } from "@saarthi/core";

const env = loadBaseEnv();
const db = openDb(env.dbPath);
const applied = migrate(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : `Database is up to date (${env.dbPath}).`);
db.close();
