// Phone sessions: the PIN-unlocked cookie, and who counts as "this computer".

import { describe, expect, it } from "vitest";
import { SESSION_TTL_MS, clientAddress, createSession, isLoopback, readCookie, verifySession } from "../src/index.ts";

const SECRET = "a".repeat(64);

describe("CFG-07 phone sessions", () => {
  it("CFG-07 a session cookie is valid until it expires, and only with the right secret", () => {
    const s = createSession(SECRET, 1_000_000_000_000);
    expect(verifySession(SECRET, s.value, 1_000_000_000_000)).toBe(true);
    expect(verifySession(SECRET, s.value, 1_000_000_000_000 + SESSION_TTL_MS + 1)).toBe(false);
    expect(verifySession("b".repeat(64), s.value, 1_000_000_000_000)).toBe(false);
  });

  it("CFG-07 a forged expiry or a garbage cookie is refused", () => {
    const s = createSession(SECRET, 1_000_000_000_000);
    const [, mac] = s.value.split(".");
    expect(verifySession(SECRET, `9999999999999.${mac}`, 1_000_000_000_000)).toBe(false);
    for (const v of [undefined, "", "abc", "123.456", `${s.value}x`]) expect(verifySession(SECRET, v, 1_000_000_000_000)).toBe(false);
  });

  it("CFG-07 the gateway's client header is trusted only on a connection from this computer", () => {
    expect(clientAddress("127.0.0.1", "192.168.1.20")).toBe("192.168.1.20");
    expect(clientAddress("::ffff:127.0.0.1", "192.168.1.20")).toBe("192.168.1.20");
    // A phone talking to the API directly can't claim to be local.
    expect(clientAddress("192.168.1.20", "127.0.0.1")).toBe("192.168.1.20");
    expect(clientAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("10.0.0.5")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });

  it("CFG-07 cookies are read by exact name", () => {
    expect(readCookie("a=1; saarthi_session=xyz; b=2", "saarthi_session")).toBe("xyz");
    expect(readCookie("xsaarthi_session=bad", "saarthi_session")).toBeUndefined();
    expect(readCookie(undefined, "saarthi_session")).toBeUndefined();
  });
});
