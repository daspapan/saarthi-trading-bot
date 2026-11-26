// Starts the dashboard. Normally Next.js listens on 127.0.0.1:3000 only.
// With ALLOW_LAN=true (and a PIN set), Next.js moves to 127.0.0.1:3001 and the LAN
// gateway listens on all interfaces at :3000, so your phone can reach it; the API
// itself stays on 127.0.0.1 and asks the phone for the PIN.
//   node scripts/web.ts dev | start

import { spawn } from "node:child_process";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { startLanGateway } from "./lanGateway.ts";

const mode = process.argv[2] === "start" ? "start" : "dev";
const allowLan = process.env.ALLOW_LAN === "true" || process.env.ALLOW_LAN === "1";
const PORT = 3000;

if (allowLan && !process.env.PIN_HASH) {
  console.error("ALLOW_LAN=true needs PIN_HASH first (npm run pin:hash -- <pin>). Refusing to open the dashboard to the network.");
  process.exit(1);
}

const nextPort = allowLan ? PORT + 1 : PORT;
const webDir = join(import.meta.dirname, "..", "apps", "web");
const child = spawn("npx", ["next", mode, "-H", "127.0.0.1", "-p", String(nextPort)], { cwd: webDir, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => child.kill(sig));

if (allowLan) {
  try {
    await startLanGateway({ listenHost: "0.0.0.0", listenPort: PORT, targetPort: nextPort });
  } catch (err) {
    console.error(`Could not open port ${PORT} for your phone: ${(err as Error).message}. Is another dashboard still running?`);
    child.kill("SIGTERM");
    process.exit(1);
  }
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i!.address);
  console.log(`Dashboard on your network: ${ips.map((ip) => `http://${ip}:${PORT}`).join("  ")}  (phones must enter the PIN)`);
}
