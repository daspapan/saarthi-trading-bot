// Data-quality monitor for the two price feeds.
//
// Feed A is the trading venue (Binance Spot Testnet). Feed B is an independent
// public stream used only to cross-check prices. New signals are paused when:
//   - either feed has had no data for a pair for `staleMs` (default 15 s), or
//   - a feed's connection is down, or
//   - the two prices for a pair differ by MORE than `disagreementBps` (default 50).
// Signals resume only after everything has been fine for `resumeMs` (default 60 s).
//
// Pure: no timers, no I/O. The caller passes the clock in, so tests are exact.

export type FeedId = "A" | "B";
export type FeedStatus = "ok" | "stale" | "down";

export type MonitorOptions = {
  pairs: readonly string[];
  staleMs: number;
  disagreementBps: number;
  resumeMs: number;
};

export type PairCheck = {
  pair: string;
  priceA: number | null;
  priceB: number | null;
  disagreementBps: number | null;
  agrees: boolean | null; // null when one side has no fresh price
};

export type FeedReport = {
  status: FeedStatus;
  lastDataMs: number | null;
  stalePairs: string[];
  detail: string;
};

export type Evaluation = {
  feeds: Record<FeedId, FeedReport>;
  pairs: PairCheck[];
  problems: string[];
  paused: boolean;
  reason: string | null;
  agreeSinceMs: number | null;
  resumeInMs: number | null;
  /** Set only on the evaluation where the state flipped. Use it to alert once. */
  change: "paused" | "resumed" | null;
};

/** Gap between two prices in basis points of their midpoint (1 bp = 0.01%). */
export function disagreementBps(a: number, b: number): number {
  return (Math.abs(a - b) / ((a + b) / 2)) * 10_000;
}

/** Short, readable price for messages: 97412.03 rather than 97412.03476505345. */
export function roundPrice(p: number): number {
  return Number(p.toFixed(p >= 100 ? 2 : p >= 1 ? 4 : 6));
}

type FeedState = {
  connected: boolean;
  downReason: string | null;
  last: Map<string, { price: number; timeMs: number }>;
};

export class FeedMonitor {
  private feeds: Record<FeedId, FeedState> = {
    A: { connected: false, downReason: "not connected yet", last: new Map() },
    B: { connected: false, downReason: "not connected yet", last: new Map() },
  };
  // We start paused: nothing is trusted until both feeds have agreed for resumeMs.
  private paused = true;
  private agreeSinceMs: number | null = null;
  private opts: MonitorOptions;

  constructor(opts: MonitorOptions) {
    this.opts = opts;
  }

  /** Replace thresholds at runtime (e.g. after a settings change). */
  setOptions(opts: Partial<MonitorOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  recordPrice(feed: FeedId, pair: string, price: number, timeMs: number): void {
    if (!Number.isFinite(price) || price <= 0) return;
    this.feeds[feed].last.set(pair, { price, timeMs });
  }

  setConnected(feed: FeedId, connected: boolean, reason: string | null = null): void {
    this.feeds[feed].connected = connected;
    this.feeds[feed].downReason = connected ? null : (reason ?? "connection lost");
  }

  private feedReport(id: FeedId, nowMs: number): FeedReport {
    const f = this.feeds[id];
    const stalePairs = this.opts.pairs.filter((p) => {
      const last = f.last.get(p);
      return !last || nowMs - last.timeMs >= this.opts.staleMs;
    });
    const times = [...f.last.values()].map((v) => v.timeMs);
    const lastDataMs = times.length ? Math.max(...times) : null;
    const name = id === "A" ? "Feed A" : "Feed B";
    if (!f.connected) {
      return { status: "down", lastDataMs, stalePairs, detail: `${name} is down: ${f.downReason}` };
    }
    if (stalePairs.length) {
      const secs = Math.round(this.opts.staleMs / 1000);
      return { status: "stale", lastDataMs, stalePairs, detail: `${name} has no data for ${secs} s on ${stalePairs.join(", ")}` };
    }
    return { status: "ok", lastDataMs, stalePairs, detail: `${name} is live` };
  }

  evaluate(nowMs: number): Evaluation {
    const feeds = { A: this.feedReport("A", nowMs), B: this.feedReport("B", nowMs) };
    const problems: string[] = [];
    if (feeds.A.status !== "ok") problems.push(feeds.A.detail);
    if (feeds.B.status !== "ok") problems.push(feeds.B.detail);

    const pairs: PairCheck[] = this.opts.pairs.map((pair) => {
      const a = feeds.A.stalePairs.includes(pair) ? undefined : this.feeds.A.last.get(pair);
      const b = feeds.B.stalePairs.includes(pair) ? undefined : this.feeds.B.last.get(pair);
      if (!a || !b) {
        return {
          pair,
          priceA: this.feeds.A.last.get(pair)?.price ?? null,
          priceB: this.feeds.B.last.get(pair)?.price ?? null,
          disagreementBps: null,
          agrees: null,
        };
      }
      const bps = disagreementBps(a.price, b.price);
      const agrees = bps <= this.opts.disagreementBps;
      if (!agrees) {
        problems.push(
          `${pair}: feeds disagree by ${bps.toFixed(1)} bps (limit ${this.opts.disagreementBps} bps): ` +
            `feed A ${roundPrice(a.price)} vs feed B ${roundPrice(b.price)}`,
        );
      }
      return { pair, priceA: a.price, priceB: b.price, disagreementBps: Math.round(bps * 100) / 100, agrees };
    });

    let change: Evaluation["change"] = null;
    if (problems.length) {
      if (!this.paused) change = "paused";
      this.paused = true;
      this.agreeSinceMs = null;
    } else if (this.paused) {
      this.agreeSinceMs ??= nowMs;
      if (nowMs - this.agreeSinceMs >= this.opts.resumeMs) {
        this.paused = false;
        change = "resumed";
      }
    }

    let reason: string | null = null;
    if (problems.length) reason = problems.join("; ");
    else if (this.paused) reason = "Feeds agree; waiting before resuming signals";

    return {
      feeds,
      pairs,
      problems,
      paused: this.paused,
      reason,
      agreeSinceMs: this.paused ? this.agreeSinceMs : null,
      resumeInMs: this.paused && this.agreeSinceMs !== null ? this.opts.resumeMs - (nowMs - this.agreeSinceMs) : null,
      change,
    };
  }
}
