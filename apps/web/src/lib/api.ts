// Types for the API responses (shapes documented in README.md) and the SWR fetcher.

export type ProcessStatus = {
  name: string;
  status: "up" | "down" | "never-started";
  lastBeatAgoSec: number | null;
  detail: string | null;
};

export type FeedView = {
  id: "A" | "B";
  status: "ok" | "stale" | "down" | "unknown";
  lastDataAgoSec: number | null;
  detail: string;
};

export type Health = {
  ok: boolean;
  mode: string;
  testnetOnly: boolean;
  time: string;
  db: string;
  processes: ProcessStatus[];
  feeds: {
    trusted: boolean;
    paused: boolean;
    reason: string | null;
    resumeInSec: number | null;
    resumeAfterSec: number | null;
    feeds: FeedView[];
    pairs: { pair: string; priceA: number | null; priceB: number | null; disagreementBps: number | null; agrees: boolean | null }[];
  } | null;
  exchange: { venue: string; status: "ok" | "failing" | "unavailable" | "unknown"; detail: string } | null;
};

export type Price = {
  pair: string;
  bid: number | null;
  ask: number | null;
  last: number | null;
  change24hPct: number | null;
  volume24h: number | null;
  checkPrice: number | null;
  disagreementBps: number | null;
  updatedAt: string;
  ageSec: number;
};

export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API answered ${res.status}`);
  return res.json() as Promise<T>;
}
