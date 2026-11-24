"use client";

// Orders page: open positions with their stop-to-target bar, every order's path
// through the state machine, and the trade history with fees. All P&L is after fees.
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { CLOSE_REASONS, type OrderView, type PositionView, type TradesResponse, isActive, money, pnlTone, progressPct } from "@/lib/orders";
import { formatPrice } from "@/lib/status";
import { TrendArrow } from "../TrendArrow";
import { Stepper } from "./Stepper";

const time = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function Pnl({ value, big = false }: { value: number | null; big?: boolean }) {
  const tone = pnlTone(value);
  const word = tone === "up" ? "Up" : tone === "down" ? "Down" : "Flat";
  return (
    <span className={`num inline-flex items-center gap-1.5 font-black ${big ? "text-2xl" : ""} ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-muted"}`}>
      <TrendArrow tone={tone} size={big ? 20 : 16} />
      <span className="sr-only">{word}</span>
      {money(value)}
    </span>
  );
}

function PositionCard({ p }: { p: PositionView }) {
  const pct = progressPct(p);
  return (
    <article className="slide-in rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-xl font-black">
          {p.pair} <span className="ml-1 rounded-md bg-up/10 px-2 py-0.5 text-sm font-bold text-up">Long, protected</span>
        </h3>
        <div className="text-right">
          <Pnl value={p.unrealisedPnl} big />
          <p className="text-xs font-semibold text-muted">if sold now, after both fees</p>
        </div>
      </div>
      <p className="num mt-1 text-sm font-semibold text-muted">
        {p.quantity} bought at {formatPrice(p.avgEntry)} · now {p.lastPrice === null ? "no price" : formatPrice(p.lastPrice)}
      </p>

      <div className="mt-4">
        <div className="relative h-4 rounded-full bg-gradient-to-r from-down/25 via-line to-up/25">
          {pct !== null && (
            <span className="progress-marker absolute top-1/2 h-7 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded bg-text" style={{ left: `${pct}%` }}>
              <span className="sr-only">{pct}% of the way from the stop to the target</span>
            </span>
          )}
        </div>
        <div className="num mt-1.5 flex justify-between text-sm font-bold">
          <span className="text-down">Stop {p.stopPrice === null ? "n/a" : formatPrice(p.stopPrice)}</span>
          <span className="text-muted">{pct === null ? "" : `${pct}% to target`}</span>
          <span className="text-up">Target {p.targetPrice === null ? "n/a" : formatPrice(p.targetPrice)}</span>
        </div>
      </div>
    </article>
  );
}

function OrderCard({ o }: { o: OrderView }) {
  return (
    <article className="rounded-2xl border border-line bg-panel p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-black">
          #{o.id} {o.pair}{" "}
          <span className="text-muted">
            {o.direction === "exit" ? "Sell (exit)" : "Buy"} {o.type} · {o.filled > 0 && o.filled < o.quantity ? `${o.filled} of ` : ""}
            <span className="num">{o.quantity}</span>
            {o.entryPrice !== null && o.type === "limit" && <span className="num"> at {formatPrice(o.entryPrice)}</span>}
          </span>
        </h3>
        <span className="text-sm font-semibold text-muted">{time(o.createdAt)}</span>
      </div>
      <Stepper order={o} />
    </article>
  );
}

export function OrdersView() {
  const positions = useSWR<{ positions: PositionView[] }>("/backend/positions", fetcher, { refreshInterval: 2000 });
  const orders = useSWR<{ orders: OrderView[] }>("/backend/orders?limit=20", fetcher, { refreshInterval: 2000 });
  const trades = useSWR<TradesResponse>("/backend/trades", fetcher, { refreshInterval: 5000 });

  const active = (orders.data?.orders ?? []).filter((o) => isActive(o.state));
  const recent = (orders.data?.orders ?? []).filter((o) => !isActive(o.state)).slice(0, 6);
  const t = trades.data;

  return (
    <div className="space-y-8">
      <section aria-labelledby="pos">
        <h2 id="pos" className="mb-3 text-xl font-black">Open positions</h2>
        {positions.error ? (
          <p className="font-semibold text-down">Could not reach the API.</p>
        ) : !positions.data ? (
          <div className="h-32 animate-pulse rounded-2xl border border-line bg-panel" />
        ) : positions.data.positions.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-panel p-5 font-semibold text-muted">No open positions. Cash is not at risk.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">{positions.data.positions.map((p) => <PositionCard key={p.id} p={p} />)}</div>
        )}
      </section>

      <section aria-labelledby="ord">
        <h2 id="ord" className="mb-3 text-xl font-black">Orders</h2>
        {active.length === 0 && recent.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line bg-panel p-5 font-semibold text-muted">
            No orders yet. Orders appear here once a signal passes all 12 validator rules.
          </p>
        ) : (
          <div className="space-y-4">
            {active.map((o) => <OrderCard key={o.id} o={o} />)}
            {recent.length > 0 && <h3 className="pt-2 text-sm font-black uppercase tracking-wide text-muted">Finished</h3>}
            {recent.map((o) => <OrderCard key={o.id} o={o} />)}
          </div>
        )}
      </section>

      <section aria-labelledby="hist">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="hist" className="text-xl font-black">Trade history</h2>
          {t && t.totals.count > 0 && (
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm font-semibold text-muted">
              <span>{t.totals.count} trades, {t.totals.wins} won</span>
              <span>Fees paid <span className="num text-text">{money(-t.totals.fees).replace("−", "")}</span></span>
              <span className="flex items-center gap-1">Total after fees <Pnl value={t.totals.realisedPnl} /></span>
            </p>
          )}
        </div>
        <div className="overflow-x-auto rounded-2xl border border-line bg-panel shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <tr>
                {["Closed", "Pair", "Qty", "Entry", "Exit", "Fees", "Result", "P&L after fees"].map((h) => (
                  <th key={h} className="px-3 py-2 font-black">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(t?.trades ?? []).map((x) => (
                <tr key={x.orderId} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-semibold">{time(x.closedAt)}</td>
                  <td className="px-3 py-2 font-bold">{x.pair}</td>
                  <td className="num px-3 py-2">{x.quantity}</td>
                  <td className="num px-3 py-2">{x.entryPrice === null ? "n/a" : formatPrice(x.entryPrice)}</td>
                  <td className="num px-3 py-2">{x.exitPrice === null ? "n/a" : formatPrice(x.exitPrice)}</td>
                  <td className="num px-3 py-2">{(x.entryFee + (x.exitFee ?? 0)).toFixed(2)}</td>
                  <td className="px-3 py-2 font-semibold">{CLOSE_REASONS[x.closeReason ?? ""] ?? x.closeReason ?? ""}</td>
                  <td className="px-3 py-2">{x.realisedPnl === null ? <span className="font-semibold text-muted">unknown (closed outside Saarthi)</span> : <Pnl value={x.realisedPnl} />}</td>
                </tr>
              ))}
              {t && t.trades.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-5 font-semibold text-muted">No closed trades yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
