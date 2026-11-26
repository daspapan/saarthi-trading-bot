// Where the API listens: always loopback. Since phase 8 the phone reaches the
// dashboard through the web app's LAN gateway (scripts/lanGateway.ts), and the API
// asks it for the PIN; the API itself is never exposed to the network.
// ALLOW_LAN still needs a PIN hash, checked here so the API refuses to start without one.

import { ConfigError, type BaseEnv } from "./config/env.ts";

export function resolveBindHost(env: Pick<BaseEnv, "apiHost" | "allowLan" | "pinHash">): string {
  if (env.allowLan) {
    if (!env.pinHash) {
      throw new ConfigError("ALLOW_LAN=true needs PIN_HASH to be set first (npm run pin:hash -- <pin>).");
    }
    return "127.0.0.1";
  }
  const loopback = ["127.0.0.1", "localhost", "::1"];
  if (!loopback.includes(env.apiHost)) {
    throw new ConfigError(`API_HOST="${env.apiHost}" is not loopback. To allow your phone, set ALLOW_LAN=true instead.`);
  }
  return env.apiHost === "localhost" ? "127.0.0.1" : env.apiHost;
}
