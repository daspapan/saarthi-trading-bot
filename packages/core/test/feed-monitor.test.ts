import { describe, expect, it } from "vitest";
import { FeedMonitor, disagreementBps, roundPrice } from "../src/index.ts";

const PAIRS = ["BTC/USDT", "ETH/USDT"];
const OPTS = { pairs: PAIRS, staleMs: 15_000, disagreementBps: 50, resumeMs: 60_000 };

/** A monitor where both feeds are connected and fed agreeing prices at time `t`. */
function healthyMonitor(t: number) {
  const m = new FeedMonitor(OPTS);
  m.setConnected("A", true);
  m.setConnected("B", true);
  feed(m, t);
  return m;
}

function feed(m: FeedMonitor, t: number, btcB = 100_000, ethB = 3_000) {
  m.recordPrice("A", "BTC/USDT", 100_000, t);
  m.recordPrice("A", "ETH/USDT", 3_000, t);
  m.recordPrice("B", "BTC/USDT", btcB, t);
  m.recordPrice("B", "ETH/USDT", ethB, t);
}

/** Price that is exactly `bps` basis points away from 100,000 (measured on the midpoint). */
const priceAtBps = (bps: number) => (100_000 * (20_000 + bps)) / (20_000 - bps);

/** Runs the monitor until it has resumed (60 s of agreement), feeding fresh data each second. */
function runUntilResumed(m: FeedMonitor, from: number): number {
  let t = from;
  for (; t <= from + 61_000; t += 1_000) {
    feed(m, t);
    if (!m.evaluate(t).paused) return t;
  }
  throw new Error("never resumed");
}

describe("FEED-03 a feed with no data for 15 seconds is stale", () => {
  it("FEED-03 starts paused until both feeds are connected and have data", () => {
    const m = new FeedMonitor(OPTS);
    const ev = m.evaluate(0);
    expect(ev.paused).toBe(true);
    expect(ev.feeds.A.status).toBe("down");
    expect(ev.change).toBeNull(); // starting paused is not an alarm
  });

  it("FEED-03 14.999 s without data is fine, 15 s is stale and pauses signals with an alarm", () => {
    const m = healthyMonitor(0);
    const resumedAt = runUntilResumed(m, 0);

    // Feed B goes silent from here on; feed A keeps ticking.
    m.recordPrice("A", "BTC/USDT", 100_000, resumedAt + 14_999);
    m.recordPrice("A", "ETH/USDT", 3_000, resumedAt + 14_999);
    const before = m.evaluate(resumedAt + 14_999);
    expect(before.feeds.B.status).toBe("ok");
    expect(before.paused).toBe(false);

    m.recordPrice("A", "BTC/USDT", 100_000, resumedAt + 15_000);
    m.recordPrice("A", "ETH/USDT", 3_000, resumedAt + 15_000);
    const after = m.evaluate(resumedAt + 15_000);
    expect(after.feeds.B.status).toBe("stale");
    expect(after.feeds.B.stalePairs).toEqual(PAIRS);
    expect(after.paused).toBe(true);
    expect(after.change).toBe("paused");
    expect(after.reason).toMatch(/Feed B has no data for 15 s/);

    // The alarm fires once, not every second.
    expect(m.evaluate(resumedAt + 16_000).change).toBeNull();
  });

  it("FEED-03 one silent pair on one feed is enough to pause", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    m.recordPrice("A", "BTC/USDT", 100_000, t + 20_000);
    m.recordPrice("B", "BTC/USDT", 100_000, t + 20_000);
    m.recordPrice("B", "ETH/USDT", 3_000, t + 20_000); // A's ETH is silent
    const ev = m.evaluate(t + 20_000);
    expect(ev.feeds.A.stalePairs).toEqual(["ETH/USDT"]);
    expect(ev.paused).toBe(true);
  });

  it("FEED-03 a dropped connection pauses immediately, even with recent data", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    m.setConnected("A", false, "socket closed");
    const ev = m.evaluate(t + 1);
    expect(ev.feeds.A.status).toBe("down");
    expect(ev.change).toBe("paused");
    expect(ev.reason).toMatch(/Feed A is down: socket closed/);
  });

  it("FEED-03 ignores non-positive or NaN prices instead of treating them as data", () => {
    const m = healthyMonitor(0);
    m.recordPrice("A", "BTC/USDT", 0, 10_000);
    m.recordPrice("A", "BTC/USDT", Number.NaN, 10_000);
    expect(m.evaluate(15_000).feeds.A.stalePairs).toContain("BTC/USDT");
  });
});

describe("FEED-04 disagreement above 50 bps pauses signals", () => {
  it("FEED-04 the disagreement is measured in basis points of the midpoint", () => {
    expect(disagreementBps(100, 100)).toBe(0);
    expect(disagreementBps(99.5, 100.5)).toBeCloseTo(100, 6);
    expect(disagreementBps(priceAtBps(50), 100_000)).toBeCloseTo(50, 6);
  });

  it("FEED-04 49 bps does not pause", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, priceAtBps(49));
    const ev = m.evaluate(t + 1_000);
    expect(ev.paused).toBe(false);
    expect(ev.pairs[0]).toMatchObject({ pair: "BTC/USDT", agrees: true, disagreementBps: 49 });
  });

  it("FEED-04 a gap right at the 50 bps limit is still allowed (the rule is: more than 50)", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, priceAtBps(50) - 0.01);
    expect(m.evaluate(t + 1_000).paused).toBe(false);
  });

  it("FEED-04 51 bps pauses, names the pair and both prices, and raises the alarm once", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, priceAtBps(51));
    const ev = m.evaluate(t + 1_000);
    expect(ev.paused).toBe(true);
    expect(ev.change).toBe("paused");
    expect(ev.reason).toBe("BTC/USDT: feeds disagree by 51.0 bps (limit 50 bps): feed A 100000 vs feed B 100511.3");
    expect(ev.pairs[0]?.agrees).toBe(false);
  });

  it("FEED-04 B below A counts the same as B above A", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, 100_000 * (1 - 0.0052));
    expect(m.evaluate(t + 1_000).paused).toBe(true);
  });

  it("FEED-04 the threshold can be changed at runtime", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    m.setOptions({ disagreementBps: 20 });
    feed(m, t + 1_000, priceAtBps(30));
    expect(m.evaluate(t + 1_000).paused).toBe(true);
  });
});

describe("FEED-04 readable messages", () => {
  it("FEED-04 prices in the pause reason are rounded for people", () => {
    expect(roundPrice(97412.03476505345)).toBe(97412.03);
    expect(roundPrice(3.123456789)).toBe(3.1235);
    expect(roundPrice(0.123456789)).toBe(0.123457);
  });
});

describe("FEED-05 resume only after 60 seconds of agreement", () => {
  it("FEED-05 still paused at 59 s of agreement, resumed at 60 s, with a countdown", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, priceAtBps(80));
    expect(m.evaluate(t + 1_000).paused).toBe(true);

    const agreeFrom = t + 2_000;
    feed(m, agreeFrom);
    const first = m.evaluate(agreeFrom);
    expect(first.paused).toBe(true);
    expect(first.resumeInMs).toBe(60_000);

    feed(m, agreeFrom + 59_000);
    const at59 = m.evaluate(agreeFrom + 59_000);
    expect(at59.paused).toBe(true);
    expect(at59.resumeInMs).toBe(1_000);

    feed(m, agreeFrom + 60_000);
    const at60 = m.evaluate(agreeFrom + 60_000);
    expect(at60.paused).toBe(false);
    expect(at60.change).toBe("resumed");
    expect(at60.reason).toBeNull();
  });

  it("FEED-05 a single disagreement during the countdown restarts the 60 s", () => {
    const m = healthyMonitor(0);
    const t = runUntilResumed(m, 0);
    feed(m, t + 1_000, priceAtBps(80));
    m.evaluate(t + 1_000);

    feed(m, t + 2_000);
    m.evaluate(t + 2_000);
    feed(m, t + 40_000, priceAtBps(80)); // blip at 38 s into the countdown
    m.evaluate(t + 40_000);
    feed(m, t + 41_000);
    m.evaluate(t + 41_000); // countdown restarts here

    feed(m, t + 62_000);
    expect(m.evaluate(t + 62_000).paused).toBe(true); // 60 s after the first agreement, not enough
    feed(m, t + 101_000);
    expect(m.evaluate(t + 101_000).paused).toBe(false);
  });

  it("FEED-05 at startup signals stay paused for the first 60 s even when everything agrees", () => {
    const m = healthyMonitor(0);
    expect(m.evaluate(0).paused).toBe(true);
    feed(m, 59_999);
    expect(m.evaluate(59_999).paused).toBe(true);
    feed(m, 60_000);
    expect(m.evaluate(60_000).paused).toBe(false);
  });
});
