import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { ConfigError, REDACTED, createLogger, hashPin, loadBaseEnv, resolveBindHost, verifyPin } from "../src/index.ts";
import { validEnv } from "./helpers.ts";
import pretty from "pino-pretty";

const prettyTo = (sink: Writable) => pretty({ destination: sink, sync: true, colorize: false });

function captureLogger(secrets: string[]) {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  const log = createLogger("test", { secrets, destination });
  return { log, output: () => lines.join("") };
}

describe("CFG-06 keys never appear in logs", () => {
  const KEY = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
  const SECRET = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j";

  it("CFG-06 redacts key fields in logged objects", () => {
    const { log, output } = captureLogger([]);
    log.info({ apiKey: KEY, secret: SECRET, headers: { "X-MBX-APIKEY": KEY } }, "placing order");
    expect(output()).not.toContain(KEY);
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain(REDACTED);
  });

  it("CFG-06 scrubs key values inside thrown exchange errors and plain messages", () => {
    const { log, output } = captureLogger([KEY, SECRET]);
    const err = new Error(`binance {"code":-2015} GET /api/v3/account?apiKey=${KEY}&signature=${SECRET}`);
    log.error(err);
    log.error({ err }, "order failed");
    log.warn(`retrying with ${KEY}`);
    expect(output()).not.toContain(KEY);
    expect(output()).not.toContain(SECRET);
    expect(output()).toContain(REDACTED);
  });
});

describe("CFG-06 pretty logs are redacted too", () => {
  it("CFG-06 pino-pretty output never contains key values or key fields", () => {
    const KEY = "vmPUZE6mv9SD5VNHk4HlWFsOr6aKE2zvsw0MuIgwCIPy6utIco14y7Ju91duEh8A";
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    // Route pino-pretty's formatted text into our sink.
    const log = createLogger("test", { secrets: [KEY], destination: prettyTo(sink) });
    log.error(new Error(`signature failed for ${KEY}`));
    log.info({ apiKey: KEY }, "placing order");
    const out = lines.join("");
    expect(out).toContain("placing order");
    expect(out).not.toContain(KEY);
    expect(out).toContain(REDACTED);
  });
});

describe("CFG-07 network exposure", () => {
  it("CFG-07 binds to 127.0.0.1 by default", () => {
    expect(resolveBindHost(loadBaseEnv(validEnv()))).toBe("127.0.0.1");
  });

  it("CFG-07 binds to the LAN only when ALLOW_LAN=true and a PIN hash exists", () => {
    const pinHash = hashPin("4321");
    expect(resolveBindHost(loadBaseEnv(validEnv({ ALLOW_LAN: "true", PIN_HASH: pinHash })))).toBe("0.0.0.0");
  });

  it("CFG-07 refuses LAN without a PIN, and refuses a non-loopback API_HOST", () => {
    expect(() => resolveBindHost(loadBaseEnv(validEnv({ ALLOW_LAN: "true" })))).toThrow(ConfigError);
    expect(() => resolveBindHost(loadBaseEnv(validEnv({ API_HOST: "0.0.0.0" })))).toThrow(/not loopback/);
  });
});

describe("CFG-08 the PIN is stored hashed", () => {
  it("CFG-08 the stored form never contains the PIN and verifies correctly", () => {
    const stored = hashPin("482916");
    expect(stored).not.toContain("482916");
    expect(stored).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(verifyPin("482916", stored)).toBe(true);
    expect(verifyPin("482917", stored)).toBe(false);
    expect(verifyPin("482916", null)).toBe(false);
  });

  it("CFG-08 the same PIN hashes differently each time (random salt)", () => {
    expect(hashPin("1234")).not.toBe(hashPin("1234"));
  });

  it("CFG-08 a plain PIN variable in the environment is refused", () => {
    expect(() => loadBaseEnv(validEnv({ PIN: "1234" }))).toThrow(/plain PIN/);
  });
});
