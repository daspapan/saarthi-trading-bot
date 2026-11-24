// npm run pin:hash -- 123456   ->  prints a PIN_HASH line for .env.
// The plain PIN is never written anywhere by this script.
import { hashPin } from "@saarthi/core";

const pin = process.argv[2];
if (!pin) {
  console.error("Usage: npm run pin:hash -- <4 to 12 digit PIN>");
  process.exit(1);
}
console.log(`PIN_HASH=${hashPin(pin)}`);
