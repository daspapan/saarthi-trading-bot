"use client";

// One tile per pair: last price (flashes green/red on change), bid/ask,
// 24h change with an animated arrow, and the cross-check against feed B.
import { useEffect, useRef } from "react";
import useSWR from "swr";
import { type Price, fetcher } from "@/lib/api";
import { direction, formatBps, formatPct, formatPrice } from "@/lib/status";
import { TrendArrow } from "./TrendArrow";

function Tile({ p, limitBps }: { p: Price; limitBps: number }) {
  // Remember the previous price to know which way to flash.
  const prev = useRef<number | null>(null);
  const flash = prev.current !== null && p.last !== null && p.last !== prev.current ? (p.last > prev.current ? "flash-up" : "flash-down") : "";
  // Update after render (not during), so React's double render in dev doesn't swallow the flash.
  useEffect(() => {
    prev.current = p.last;
  }, [p.last]);

  const change = direction(p.change24hPct);
  const agrees = p.disagreementBps === null ? null : p.disagreementBps <= limitBps;

  return (
    <li className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-black">{p.pair}</h3>
        <span className="num text-xs font-medium text-muted">{p.ageSec}s ago</span>
      </div>

      <p key={p.last ?? "none"} className={`num mt-1 rounded-md px-1 -mx-1 text-3xl font-black ${flash}`}>
        {formatPrice(p.last)}
      </p>

      <div className="mt-1 flex items-center gap-1.5 text-base font-bold" title="Change over the last 24 hours on the testnet">
        <TrendArrow tone={change} />
        <span className={change === "up" ? "text-up" : change === "down" ? "text-down" : "text-muted"}>
          {formatPct(p.change24hPct)}
        </span>
        <span className="text-xs font-medium text-muted">24h</span>
      </div>

      <dl className="num mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="font-medium text-muted" title="Highest price a buyer is offering right now">Bid</dt>
        <dd className="text-right font-semibold">{formatPrice(p.bid)}</dd>
        <dt className="font-medium text-muted" title="Lowest price a seller is asking right now">Ask</dt>
        <dd className="text-right font-semibold">{formatPrice(p.ask)}</dd>
        <dt className="font-medium text-muted" title="The same pair on the independent cross-check feed">Feed B</dt>
        <dd className="text-right font-semibold">{formatPrice(p.checkPrice)}</dd>
        <dt
          className="font-medium text-muted"
          title={`Gap between the two feeds in basis points (1 bp = 0.01%). Above ${limitBps} bps, signals pause.`}
        >
          Gap
        </dt>
        <dd className={`whitespace-nowrap text-right font-bold ${agrees === false ? "text-down" : agrees ? "text-up" : "text-muted"}`}>
          {formatBps(p.disagreementBps)} {agrees === null ? "" : agrees ? "· agree" : "· DISAGREE"}
        </dd>
      </dl>
    </li>
  );
}

export function PriceTiles({ limitBps = 50 }: { limitBps?: number }) {
  const { data, isLoading } = useSWR<{ prices: Price[] }>("/backend/prices", fetcher, { refreshInterval: 2000 });

  if (isLoading) {
    return (
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-48 animate-pulse rounded-2xl border border-line bg-panel" />
        ))}
      </ul>
    );
  }

  if (!data?.prices.length) {
    return (
      <div className="rounded-2xl border border-dashed border-line bg-panel p-6 text-center">
        <p className="text-lg font-bold">No prices yet</p>
        <p className="text-sm font-medium text-muted">
          The feed process writes prices every 5 seconds once it is connected to the Binance testnet.
        </p>
      </div>
    );
  }

  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {data.prices.map((p) => (
        <Tile key={p.pair} p={p} limitBps={limitBps} />
      ))}
    </ul>
  );
}
