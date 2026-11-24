"use client";

// The big "are signals allowed?" banner. Red/amber when paused (with the plain
// reason and a countdown), green when the data is trusted.
import useSWR from "swr";
import { type Health, fetcher } from "@/lib/api";
import { TrendArrow } from "./TrendArrow";

export function SignalGate() {
  const { data } = useSWR<Health>("/backend/health", fetcher, { refreshInterval: 2000 });
  const feeds = data?.feeds;
  if (!feeds) return null;

  if (feeds.trusted) {
    return (
      <div role="status" className="flex items-center gap-3 rounded-2xl border border-up/40 bg-up/5 px-4 py-3 text-up">
        <TrendArrow tone="up" size={22} />
        <div>
          <p className="text-lg font-black">Signals allowed</p>
          <p className="text-sm font-medium text-text">Both price feeds are live and agree.</p>
        </div>
      </div>
    );
  }

  const countingDown = feeds.resumeInSec !== null;
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 ${
        countingDown ? "border-warn/50 bg-warn/5 text-warn" : "border-down/50 bg-down/5 text-down"
      }`}
    >
      <span className="mt-1">
        <TrendArrow tone={countingDown ? "warn" : "down"} size={22} />
      </span>
      <div>
        <p className="text-lg font-black">
          New signals paused
          {countingDown && <span className="num"> · resuming in {feeds.resumeInSec}s</span>}
        </p>
        <p className="text-sm font-medium text-text">{feeds.reason}</p>
        <p className="mt-1 text-xs font-medium text-muted">
          Signals resume only after both feeds have been live and in agreement for {feeds.resumeAfterSec ?? 60} seconds.
        </p>
      </div>
    </div>
  );
}
