import { describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { DISCLAIMER, beat, hashPin, loadBaseEnv, resolveBindHost } from "@saarthi/core";
import { tempDb, validEnv } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/app.ts";

async function listen(env = loadBaseEnv(validEnv())) {
  const { db } = tempDb();
  const app = createApp(db, env);
  const host = resolveBindHost(env);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, host, () => resolve(s));
  });
  const { address, port } = server.address() as AddressInfo;
  return { db, server, address, url: `http://127.0.0.1:${port}` };
}

describe("API-02 GET /health", () => {
  it("API-02 returns the documented shape and process heartbeats", async () => {
    const { db, server, url } = await listen();
    beat(db, "feed", "test");
    const res = await fetch(`${url}/health`);
    const body = await res.json();
    server.close();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, mode: "paper", testnetOnly: true, db: "ok", disclaimer: DISCLAIMER });
    expect(body.processes.map((p: { name: string }) => p.name)).toEqual(["api", "feed", "analyst", "executor", "risk"]);
    expect(body.processes.find((p: { name: string }) => p.name === "feed").status).toBe("up");
    expect(body.processes.find((p: { name: string }) => p.name === "risk").status).toBe("never-started");
  });

  it("API-03 unknown routes give a plain-language error with no stack trace", async () => {
    const { server, url } = await listen();
    const res = await fetch(`${url}/nope`);
    const text = await res.text();
    server.close();
    expect(res.status).toBe(404);
    expect(JSON.parse(text)).toEqual({ error: "Not found." });
    expect(text).not.toMatch(/at \w+ \(|node_modules/);
  });
});

describe("CFG-07 the real server binds where it should", () => {
  it("CFG-07 listens on 127.0.0.1 by default", async () => {
    const { server, address } = await listen();
    server.close();
    expect(address).toBe("127.0.0.1");
  });

  it("CFG-07 listens on all interfaces only when LAN is enabled", async () => {
    const { server, address } = await listen(
      loadBaseEnv(validEnv({ ALLOW_LAN: "true", PIN_HASH: hashPin("2468") })),
    );
    server.close();
    expect(address).toBe("0.0.0.0");
  });
});
