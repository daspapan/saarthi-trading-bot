"use client";

// System health: the two price feeds, the exchange, and each process.
// Polls GET /health every 2 seconds.
import useSWR from "swr";
import { type Health, fetcher } from "@/lib/api";
import { agoText, exchangePill, feedPill, processPill } from "@/lib/status";
import { StatusPill } from "./StatusPill";

const FEED_NAMES = { A: "Feed A · Binance testnet", B: "Feed B · cross-check" } as const;
const FEED_HELP = {
  A: "The exchange we trade on (virtual money). Prices and candles come from here.",
  B: "An independent public price stream, used only to check that feed A's prices are real.",
} as const;

export function HealthStrip() {
  const { data, error, isLoading } = useSWR<Health>("/backend/health", fetcher, { refreshInterval: 2000 });

  if (isLoading) {
    return <div className="h-40 animate-pulse rounded-2xl border border-line bg-panel" aria-label="Loading health" />;
  }

  if (error || !data) {
    return (
      <div role="alert" className="rounded-2xl border border-down/50 bg-down/5 p-4 text-down">
        <p className="font-bold">The API is not reachable.</p>
        <p className="text-sm text-text">
          Is <code className="num">npm run dev</code> running? The API listens on 127.0.0.1:4000.
        </p>
      </div>
    );
  }

  return (
    <section aria-label="System health" className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <h2 className="text-lg font-black">System health</h2>
        <span className="rounded-md border border-accent/40 bg-accent/5 px-2 py-0.5 font-bold uppercase text-accent">
          mode: {data.mode}
        </span>
        <span className="font-medium text-muted">database: {data.db}</span>
        <span className="num ml-auto font-medium text-muted">updated {new Date(data.time).toLocaleTimeString()}</span>
      </div>

      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted">Market data</h3>
      <ul className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(data.feeds?.feeds ?? []).map((f) => (
          <StatusPill
            key={f.id}
            name={FEED_NAMES[f.id]}
            pill={feedPill(f.status)}
            sub={f.lastDataAgoSec === null ? "no data yet" : `last data ${agoText(f.lastDataAgoSec)}`}
            tooltip={`${FEED_HELP[f.id]} ${f.detail}`}
          />
        ))}
        {data.exchange && (
          <StatusPill
            name="Exchange API"
            pill={exchangePill(data.exchange.status)}
            sub="checked every 30 s"
            tooltip={data.exchange.detail}
          />
        )}
      </ul>

      <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted">Processes</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {data.processes.map((p) => (
          <StatusPill
            key={p.name}
            name={p.name[0]!.toUpperCase() + p.name.slice(1)}
            pill={processPill(p.status)}
            sub={p.lastBeatAgoSec === null ? undefined : `beat ${agoText(p.lastBeatAgoSec)}`}
            tooltip={p.detail ?? undefined}
          />
        ))}
      </ul>
    </section>
  );
}
