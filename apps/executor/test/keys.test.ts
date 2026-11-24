// EX-19: only the executor process reads exchange keys.
// A static check over every source file, plus a runtime check that records who reads them.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { SECRET_ENV_KEYS, loadAnalystEnv, loadBaseEnv } from "@saarthi/core";
import { tempDb } from "../../../packages/core/test/helpers.ts";
import { createApp } from "../../api/src/app.ts";
import { loadExchangeKeys } from "../src/secrets.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const KEY_NAME = /\b(BINANCE|BYBIT)_API_(KEY|SECRET)\b/;
// env.BINANCE_API_KEY or env["BINANCE_API_KEY"] (but not a string like "env.BINANCE_API_KEY" in a list)
const DOT_READ = /\.[ \t]*(BINANCE|BYBIT)_API_(KEY|SECRET)\b/;
const BRACKET_READ = /[\w)\]][ \t]*\[[ \t]*["'`](BINANCE|BYBIT)_API_(KEY|SECRET)["'`][ \t]*\]/;
const readsKeys = (src: string) => {
  const code = src.replace(/^\s*(\/\/|\*).*$/gm, "");
  return DOT_READ.test(code.replace(/"[^"\n]*"/g, '""')) || BRACKET_READ.test(code);
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === "test") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

const files = [...sourceFiles(join(ROOT, "apps")), ...sourceFiles(join(ROOT, "packages")), ...sourceFiles(join(ROOT, "scripts"))].map((f) => ({
  path: relative(ROOT, f),
  src: readFileSync(f, "utf8"),
}));

describe("EX-19 only the executor reads the keys (static check)", () => {
  it("EX-19 the scan covers every app and the core package", () => {
    for (const dir of ["apps/api/src", "apps/analyst/src", "apps/feed/src", "apps/risk/src", "apps/web/src", "apps/executor/src", "packages/core/src"]) {
      expect(files.some((f) => f.path.startsWith(dir)), dir).toBe(true);
    }
  });

  it("EX-19 key values are read in exactly one file: apps/executor/src/secrets.ts", () => {
    const readers = files.filter((f) => readsKeys(f.src)).map((f) => f.path);
    expect(readers).toEqual(["apps/executor/src/secrets.ts"]);
  });

  it("EX-19 key names appear only in the executor, the analyst's refusal list and the log redaction list", () => {
    const mentions = files.filter((f) => KEY_NAME.test(f.src)).map((f) => f.path).sort();
    expect(mentions).toEqual(["apps/executor/src/client.ts", "apps/executor/src/secrets.ts", "packages/core/src/config/env.ts", "packages/core/src/logger.ts"]);
  });

  it("EX-19 the check itself catches both ways of reading a key", () => {
    expect(readsKeys("const k = process.env.BINANCE_API_KEY;")).toBe(true);
    expect(readsKeys('const k = env["BYBIT_API_SECRET"];')).toBe(true);
    expect(readsKeys('const names = ["BINANCE_API_KEY"];')).toBe(false);
    expect(readsKeys('redact: ["env.BINANCE_API_KEY"]')).toBe(false);
  });

  it("EX-19 nothing outside apps/executor imports secrets.ts or loadExchangeKeys", () => {
    const importers = files.filter((f) => /secrets\.ts["']|loadExchangeKeys/.test(f.src)).map((f) => f.path).sort();
    expect(importers.every((p) => p.startsWith("apps/executor/src/"))).toBe(true);
  });

  it("EX-19 the web app and the analyst never mention exchange keys at all", () => {
    expect(files.filter((f) => (f.path.startsWith("apps/web/") || f.path.startsWith("apps/analyst/")) && KEY_NAME.test(f.src))).toEqual([]);
  });
});

describe("EX-19 only the executor reads the keys (runtime check)", () => {
  /** An environment that remembers which secret variables anyone read. */
  function spyEnv() {
    const reads: string[] = [];
    const base: Record<string, string> = { TRADING_MODE: "paper", BINANCE_API_KEY: "live-key-123", BINANCE_API_SECRET: "live-secret-456" };
    const env = new Proxy(base, {
      get(t, k) {
        if (typeof k === "string" && (SECRET_ENV_KEYS as readonly string[]).includes(k)) reads.push(k);
        return t[k as string];
      },
    });
    return { env, reads };
  }

  it("EX-19 the shared config loader and the API server read no key values", async () => {
    const { env, reads } = spyEnv();
    const base = loadBaseEnv(env);
    const app = createApp(tempDb().db, base);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const { port } = server.address() as { port: number };
    await fetch(`http://127.0.0.1:${port}/health`);
    await fetch(`http://127.0.0.1:${port}/settings`);
    server.close();
    expect(reads).toEqual([]);
    expect(JSON.stringify(base)).not.toMatch(/live-key|live-secret/);
  });

  it("EX-19 the analyst's loader spots the keys without reading them, and refuses to start", () => {
    const { env, reads } = spyEnv();
    expect(() => loadAnalystEnv(env)).toThrow(/must never see exchange keys/);
    expect(reads).toEqual([]);
  });

  it("EX-19 the executor's loader is the one that reads them (positive control)", () => {
    const { env, reads } = spyEnv();
    expect(loadExchangeKeys(env).binance).toEqual({ apiKey: "live-key-123", secret: "live-secret-456" });
    expect(reads).toEqual(expect.arrayContaining(["BINANCE_API_KEY", "BINANCE_API_SECRET"]));
  });
});
