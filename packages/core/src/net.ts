// Where the API listens. Default is loopback only; LAN is an explicit opt-in
// and only allowed when a PIN hash exists (the kill switch and settings need it).

import { ConfigError, type BaseEnv } from "./config/env.ts";

export function resolveBindHost(env: Pick<BaseEnv, "apiHost" | "allowLan" | "pinHash">): string {
  if (env.allowLan) {
    if (!env.pinHash) {
      throw new ConfigError("ALLOW_LAN=true needs PIN_HASH to be set first (npm run pin:hash -- <pin>).");
    }
    return "0.0.0.0";
  }
  const loopback = ["127.0.0.1", "localhost", "::1"];
  if (!loopback.includes(env.apiHost)) {
    throw new ConfigError(`API_HOST="${env.apiHost}" is not loopback. To allow your phone, set ALLOW_LAN=true instead.`);
  }
  return env.apiHost === "localhost" ? "127.0.0.1" : env.apiHost;
}
