// POST /kill, POST /restart, GET /risk, GET /alerts (RISK-08, RISK-10, RISK-11, API-02, API-03).

import { describe, expect, it } from "vitest";
import { getRiskFlag, hashPin, loadBaseEnv, raiseAlert } from "@saarthi/core";
import { tempDb, validEnv } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/app.ts";

const PIN_HASH = hashPin("2468");

async function serve(pinHash: string | null = PIN_HASH) {
  const { db } = tempDb();
  const env = { ...loadBaseEnv(validEnv()), pinHash, configDir: new URL("../../../config", import.meta.url).pathname };
  const app = createApp(db, env, { analystToken: "t".repeat(64) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { db, call, close: () => server.close() };
}

const audits = (db: ReturnType<typeof tempDb>["db"], type: string) => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE event_type = ?").get(type) as { n: number }).n;

describe("RISK-08 POST /kill needs the PIN", () => {
  it("RISK-08 the correct PIN turns everything off and starts closing", async () => {
    const s = await serve();
    const r = await s.call("POST", "/kill", { pin: "2468" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ alreadyActive: false, message: expect.stringMatching(/Kill switch on/) });
    for (const f of ["kill_switch", "manual_restart", "liquidate"]) expect(getRiskFlag(s.db, f).active).toBe(true);
    expect(audits(s.db, "kill_switch")).toBe(1);
    s.close();
  });

  it("RISK-08 a wrong or missing PIN is rejected, audited, and changes nothing", async () => {
    const s = await serve();
    expect((await s.call("POST", "/kill", { pin: "0000" })).status).toBe(403);
    const missing = await s.call("POST", "/kill", {});
    expect(missing).toEqual({ status: 403, body: { error: "Wrong PIN. Nothing was changed." } });
    expect(getRiskFlag(s.db, "kill_switch").active).toBe(false);
    expect(audits(s.db, "pin_rejected")).toBe(2);
    expect(audits(s.db, "kill_switch")).toBe(0);
    s.close();
  });

  it("RISK-08 after 5 wrong PINs in a minute, further tries are locked out (even the right one) and the terminal is suggested", async () => {
    const s = await serve();
    for (let i = 0; i < 5; i++) await s.call("POST", "/kill", { pin: "1111" });
    const locked = await s.call("POST", "/kill", { pin: "2468" });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/npm run kill/);
    s.close();
  });

  it("RISK-11 pressing twice through the API is safe", async () => {
    const s = await serve();
    await s.call("POST", "/kill", { pin: "2468" });
    const again = await s.call("POST", "/kill", { pin: "2468" });
    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({ alreadyActive: true, message: "Already closing everything." });
    expect(s.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE kind = 'kill_switch'").get()).toEqual({ n: 1 });
    s.close();
  });

  it("RISK-10 without a PIN configured the kill switch still works (it only makes things safer)", async () => {
    const s = await serve(null);
    expect((await s.call("POST", "/kill", {})).status).toBe(202);
    expect((await s.call("GET", "/risk")).body.pinRequired).toBe(false);
    s.close();
  });
});

describe("RISK-07 POST /restart", () => {
  it("RISK-07 wrong PIN 403, right PIN restarts once nothing is left to close", async () => {
    const s = await serve();
    await s.call("POST", "/kill", { pin: "2468" });
    expect((await s.call("POST", "/restart", { pin: "2468" })).status).toBe(409); // the executor hasn't finished
    s.db.prepare("UPDATE risk_flags SET active = 0 WHERE name = 'liquidate'").run(); // as the executor does when done
    expect((await s.call("POST", "/restart", { pin: "9999" }))).toEqual({ status: 403, body: { error: "Wrong PIN. Trading stays stopped." } });
    expect(await s.call("POST", "/restart", { pin: "2468" })).toEqual({ status: 200, body: { ok: true, message: "Trading restarted." } });
    expect(getRiskFlag(s.db, "kill_switch").active).toBe(false);
    s.close();
  });
});

describe("API-02 GET /risk and GET /alerts", () => {
  it("API-02 /risk has the documented shape, before and after the first equity figure", async () => {
    const s = await serve();
    const empty = (await s.call("GET", "/risk")).body;
    expect(empty).toMatchObject({ equity: null, assessment: null, pinRequired: true, flags: { killSwitch: { active: false }, liquidating: { active: false, ordersLeft: 0 } } });
    s.db.prepare("INSERT INTO equity_snapshots (equity, cash, high_water_mark, day_start_equity, created_at) VALUES (9900, 9900, 10000, 10000, ?)").run(new Date().toISOString());
    const v = (await s.call("GET", "/risk")).body;
    expect(v).toMatchObject({ equity: 9900, dayStartEquity: 10000, highWaterMark: 10000, assessment: { dailyPnl: -100, dailyUsedPct: 50, drawdownPct: 1 } });
    expect(Object.keys(v).sort()).toEqual(["assessment", "breakdown", "cash", "dayStartEquity", "equity", "equityAgeSec", "equityAt", "exposure", "flags", "highWaterMark", "limits", "pinRequired"]);
    s.close();
  });

  it("API-02 /alerts?after=N returns only newer alerts, oldest first, plus the latest ID", async () => {
    const s = await serve();
    raiseAlert(s.db, { level: "info", kind: "order_filled", message: "a", key: "1" });
    raiseAlert(s.db, { level: "warn", kind: "stop_hit", message: "b", key: "2" });
    const all = (await s.call("GET", "/alerts")).body;
    expect(all.alerts.map((a: { message: string }) => a.message)).toEqual(["b", "a"]);
    const first = all.alerts[1].id;
    const newer = (await s.call("GET", `/alerts?after=${first}`)).body;
    expect(newer).toEqual({ latestId: all.latestId, alerts: [expect.objectContaining({ message: "b", level: "warn", kind: "stop_hit" })] });
    s.close();
  });
});
