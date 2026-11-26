// Phone lock, settings, audit and performance endpoints (CFG-04, CFG-07, AUD-02, AUD-03, API-02, API-03).

import { describe, expect, it } from "vitest";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, hashPin, loadBaseEnv, loadSettingsFile } from "@saarthi/core";
import { tempDb, validEnv } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../src/app.ts";

const REAL = join(import.meta.dirname, "..", "..", "..", "config");

async function serve(o: { pinHash?: string | null; lan?: boolean } = {}) {
  const { db } = tempDb();
  const configDir = mkdtempSync(join(tmpdir(), "saarthi-api-cfg-"));
  for (const f of ["strategy.json", "risk.json"]) copyFileSync(join(REAL, f), join(configDir, f));
  const pinHash = o.pinHash === undefined ? hashPin("2468") : o.pinHash;
  const env = { ...loadBaseEnv(validEnv()), pinHash, configDir, allowLan: o.lan ?? true };
  const app = createApp(db, env, { analystToken: "t".repeat(64), sessionSecret: "s".repeat(64) });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  /** `from` simulates the LAN gateway telling the API who the caller really is. */
  const call = async (method: string, path: string, body?: unknown, h: { from?: string; cookie?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (h.from) headers["x-saarthi-client"] = h.from;
    if (h.cookie) headers.cookie = h.cookie;
    const res = await fetch(url + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, setCookie: res.headers.get("set-cookie") };
  };
  return { db, configDir, call, close: () => server.close() };
}

describe("CFG-07 the dashboard asks a phone for the PIN", () => {
  it("CFG-07 this computer is never asked; a phone is locked out of everything but /session", async () => {
    const s = await serve();
    expect((await s.call("GET", "/risk")).status).toBe(200);
    expect(await s.call("GET", "/session")).toMatchObject({ body: { local: true, unlocked: true, pinRequired: true, lanEnabled: true } });
    const phone = { from: "192.168.1.20" };
    for (const [m, p] of [["GET", "/risk"], ["GET", "/orders"], ["POST", "/kill"], ["GET", "/audit"], ["POST", "/settings"]] as const) {
      expect(await s.call(m, p, m === "GET" ? undefined : {}, phone)).toMatchObject({ status: 401, body: { locked: true } });
    }
    expect(await s.call("GET", "/session", undefined, phone)).toMatchObject({ status: 200, body: { local: false, unlocked: false } });
    s.close();
  });

  it("CFG-07 the right PIN gives the phone an HttpOnly session cookie that unlocks it; a wrong PIN is audited", async () => {
    const s = await serve();
    const phone = { from: "192.168.1.20" };
    expect((await s.call("POST", "/session", { pin: "0000" }, phone)).status).toBe(403);
    const ok = await s.call("POST", "/session", { pin: "2468" }, phone);
    expect(ok.status).toBe(200);
    expect(ok.setCookie).toMatch(/^saarthi_session=\d{13}\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43(19\d|200)$/);
    const cookie = ok.setCookie!.split(";")[0]!;
    expect((await s.call("GET", "/risk", undefined, { ...phone, cookie })).status).toBe(200);
    expect((await s.call("GET", "/risk", undefined, { ...phone, cookie: "saarthi_session=9999999999999.abc" })).status).toBe(401);
    const types = (s.db.prepare("SELECT event_type FROM audit_log ORDER BY id").all() as { event_type: string }[]).map((r) => r.event_type);
    expect(types).toEqual(["pin_rejected", "session_unlocked"]);
    s.close();
  });

  it("CFG-07 with no PIN set, phones can't unlock at all", async () => {
    const s = await serve({ pinHash: null });
    expect(await s.call("POST", "/session", { pin: "2468" }, { from: "10.0.0.9" })).toMatchObject({ status: 409 });
    s.close();
  });
});

describe("CFG-04 settings through the API", () => {
  it("CFG-04 preview, then save with the PIN; the change is live for the next request", async () => {
    const s = await serve();
    const preview = await s.call("POST", "/settings/preview", { file: "risk.json", changes: { riskPerTradeBps: 60, feedStaleSeconds: 20 } });
    expect(preview.body.lines.map((l: { key: string; ok: boolean; restart: string | null }) => [l.key, l.ok, !!l.restart])).toEqual([["riskPerTradeBps", true, false], ["feedStaleSeconds", true, true]]);
    expect((await s.call("POST", "/settings", { file: "risk.json", changes: { riskPerTradeBps: 60 }, pin: "1111" })).status).toBe(403);
    const saved = await s.call("POST", "/settings", { file: "risk.json", changes: { riskPerTradeBps: 60, feedStaleSeconds: 20 }, pin: "2468" });
    expect(saved.status).toBe(200);
    expect(saved.body.message).toBe("Saved 2 changes. Restart npm run dev for feedStaleSeconds to take effect.");
    expect(loadSettingsFile(s.configDir, "risk.json").riskPerTradeBps!.value).toBe(60);
    expect((await s.call("GET", "/settings")).body.risk.riskPerTradeBps.value).toBe(60);
    const hist = (await s.call("GET", "/settings/history")).body.history;
    expect(hist.map((h: { key: string }) => h.key).sort()).toEqual(["feedStaleSeconds", "riskPerTradeBps"]);
    s.close();
  });

  it("API-03 out-of-range values are refused with the reason and the lines", async () => {
    const s = await serve();
    const r = await s.call("POST", "/settings", { file: "risk.json", changes: { maxDrawdownBps: 100 }, pin: "2468" });
    expect(r).toMatchObject({ status: 400, body: { error: "maxDrawdownBps=100 is outside the allowed range 500 to 2500.", lines: [{ key: "maxDrawdownBps", ok: false }] } });
    expect((await s.call("POST", "/settings/preview", { file: "nope.json", changes: {} })).status).toBe(400);
    s.close();
  });
});

describe("AUD-02 / AUD-03 audit endpoints", () => {
  it("AUD-02 GET /audit lists newest first with filters, and /audit/verify passes on an untouched log", async () => {
    const s = await serve();
    for (let i = 0; i < 5; i++) appendAudit(s.db, i % 2 ? "signal" : "alert", "api", { i });
    const list = (await s.call("GET", "/audit?type=signal&limit=10")).body;
    expect(list.entries.map((e: { payload: { i: number } }) => e.payload.i)).toEqual([3, 1]);
    expect(list.types).toEqual(["alert", "signal"]);
    expect((await s.call("GET", "/audit")).body.entries[0]).toMatchObject({ id: 5, eventType: "alert", actor: "api", hash: expect.any(String), prevHash: expect.any(String) });
    expect((await s.call("GET", "/audit/verify")).body).toMatchObject({ ok: true, checked: 5 });
    s.close();
  });

  it("AUD-03 after someone edits row 2 behind the app's back, verify names row 2", async () => {
    const s = await serve();
    for (let i = 0; i < 4; i++) appendAudit(s.db, "signal", "api", { i });
    s.db.exec("DROP TRIGGER audit_log_no_update; UPDATE audit_log SET payload_json = '{\"i\":99}' WHERE id = 2;");
    expect((await s.call("GET", "/audit/verify")).body).toMatchObject({ ok: false, badId: 2, checked: 1 });
    s.close();
  });
});

describe("API-02 GET /performance", () => {
  it("API-02 the documented shape, empty before any equity is recorded", async () => {
    const s = await serve();
    const p = (await s.call("GET", "/performance")).body;
    expect(Object.keys(p).sort()).toEqual(["curve", "daily", "summary", "windows"]);
    expect(p.windows.map((w: { days: number }) => w.days)).toEqual([30, 60, 90]);
    s.close();
  });
});
